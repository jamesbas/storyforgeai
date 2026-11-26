import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { proposeCardFeedback } from "@/lib/agents/card-feedback";
import { buildSceneCheckInput, sceneCheckSources } from "@/lib/agents/scene-check";
import { charactersInScene } from "@/lib/agents/scene-cast";
import { storedPromptWarnings, storedSceneImageContext } from "@/lib/agents/prompt-validation";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import { repository } from "@/lib/db/store";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import {
  CARD_TEXT_FIELDS,
  DIALOGUE_MODE_LABELS,
  cardFeedbackApplySchema,
  cardFeedbackRequestSchema,
  type CardEdit,
  type CardFeedbackApplyResult,
  type CardFeedbackPreview,
  type CardFeedbackProposal,
} from "@/lib/schemas/card-feedback";
import type { Character } from "@/lib/schemas/character";
import { rewriteOptionsFor } from "@/lib/schemas/scene-feedback";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { WardrobeChange } from "@/lib/schemas/wardrobe";
import { getAgentRun, trackAgentRun } from "@/lib/services/agent-runs";
import { resolveProjectCast } from "@/lib/services/character-service";
import { appendHistory, getProjectRecord, regenerateScenesPrompts } from "@/lib/services/project-service";
import { assertIdle } from "@/lib/services/scene-feedback-service";
import { logEvent } from "@/lib/telemetry";

/** Any change to the project, its storyboard or its cast makes a card preview stale. */
function cardSourceHash(record: ProjectRecord, cast: readonly Character[]): string {
  return createHash("sha256").update(JSON.stringify({
    project: record.project, storyboard: record.storyboard, cast,
  })).digest("hex");
}

function nameOf(change: WardrobeChange, cast: readonly Character[]): string {
  return change.characterId
    ? cast.find((c) => c.id === change.characterId)?.name ?? change.characterId
    : change.subject!;
}

/**
 * Apply card and wardrobe edits the way a hand edit is applied: the cast in
 * the shot is recomputed from the card, and prompt advisories are refreshed
 * against the new card. Pure, so a preview can run it on a working copy.
 */
export function withCardEdits(record: ProjectRecord, cast: readonly Character[], edits: readonly CardEdit[]): ProjectRecord {
  const storyboard = record.storyboard!;
  const byId = new Map(edits.map((edit) => [edit.sceneId, edit] as const));
  const wardrobeChanges = { ...(record.project.wardrobeChanges ?? {}) };
  for (const edit of edits) {
    if (!edit.wardrobe) continue;
    if (edit.wardrobe.length) wardrobeChanges[edit.sceneId] = edit.wardrobe;
    else delete wardrobeChanges[edit.sceneId];
  }
  const project = { ...record.project, wardrobeChanges };
  const scenes = storyboard.scenes.map((scene) => {
    const patch = byId.get(scene.id)?.card;
    if (!patch) return scene;
    const edited: Scene = {
      ...scene, ...patch,
      frameVisibility: patch.frameVisibility === undefined ? scene.frameVisibility : patch.frameVisibility ?? undefined,
    };
    return { ...edited, charactersPresent: charactersInScene(edited, cast).map((c) => c.name) };
  });
  const touched = new Set(edits.filter((e) => e.card || e.wardrobe).map((e) => e.sceneId));
  return {
    ...record,
    project,
    storyboard: {
      ...storyboard,
      scenes: scenes.map((scene) => touched.has(scene.id)
        ? {
            ...scene,
            prompts: {
              ...scene.prompts,
              promptWarnings: storedPromptWarnings(scene, storedSceneImageContext(
                project, scene, cast, storyboard.visualBible, scenes,
              )),
            },
          }
        : scene),
    },
  };
}

function cardContext(record: ProjectRecord, sceneId: string, cast: readonly Character[]): Record<string, unknown> {
  const sources = sceneCheckSources(record, sceneId, cast);
  if (!sources) throw new NotFoundError(`Scene ${sceneId} not found`);
  const { scene } = sources;
  const { story, neighbours } = buildSceneCheckInput(sources, "deep");
  const wardrobe = wardrobeTimeline(record.project, record.storyboard!.scenes, cast, record.storyboard!.visualBible).get(sceneId);
  const named = (byId: Record<string, string> = {}, others: Record<string, string> = {}) => ({
    ...Object.fromEntries(Object.entries(byId).map(([id, outfit]) => [cast.find((c) => c.id === id)?.name ?? id, outfit])),
    ...others,
  });
  return {
    card: {
      title: scene.title,
      sceneObjective: scene.sceneObjective,
      storyBeat: scene.storyBeat,
      visualDescription: scene.visualDescription,
      actionDescription: scene.actionDescription,
      cameraMovement: scene.cameraMovement,
      frameVisibility: scene.frameVisibility ?? { start: [], end: [] },
      dialogue: scene.dialogue ?? [],
      sceneNumber: scene.sceneNumber,
      targetDurationSeconds: scene.targetDurationSeconds,
    },
    wardrobe: {
      asSceneOpens: named(wardrobe?.start, wardrobe?.othersStart),
      asSceneCloses: named(wardrobe?.end, wardrobe?.othersEnd),
      changesAtThisScene: (record.project.wardrobeChanges?.[sceneId] ?? [])
        .map((change) => ({ who: nameOf(change, cast), wardrobe: change.wardrobe, mode: change.mode })),
    },
    cast: cast.map((c) => c.name),
    story: story ?? {},
    neighbours: neighbours ?? {},
  };
}

function describeEdit(
  scene: Scene,
  before: readonly WardrobeChange[],
  edit: CardEdit,
  proposal: CardFeedbackProposal,
  cast: readonly Character[],
): CardFeedbackPreview["scenes"][number]["changes"] {
  const reasons = new Map(proposal.revisions.map((r) => [r.field, r.reason] as const));
  const changes: CardFeedbackPreview["scenes"][number]["changes"] = [];
  for (const field of CARD_TEXT_FIELDS) {
    const after = edit.card?.[field];
    if (after !== undefined) changes.push({ field, before: scene[field], after, reason: reasons.get(field) });
  }
  const visibility = (v: Scene["frameVisibility"]) => v
    ? `Start: ${v.start.join(", ") || "nobody"}\nEnd: ${v.end.join(", ") || "nobody"}`
    : "(read from the card)";
  if (edit.card?.frameVisibility !== undefined) {
    changes.push({ field: "frameVisibility", before: visibility(scene.frameVisibility), after: visibility(edit.card.frameVisibility ?? undefined) });
  }
  const dialogue = (lines: readonly { character: string; line: string }[]) =>
    lines.map((l) => `${l.character}: "${l.line}"`).join("\n") || "(no dialogue)";
  if (edit.card?.dialogue) changes.push({ field: "dialogue", before: dialogue(scene.dialogue ?? []), after: dialogue(edit.card.dialogue) });
  if (edit.card?.dialogueMode) {
    const mode = (value: Scene["dialogueMode"]) => value ? DIALOGUE_MODE_LABELS[value] : "(read from the lines)";
    changes.push({ field: "dialogueMode", before: mode(scene.dialogueMode), after: mode(edit.card.dialogueMode) });
  }
  const wardrobe = (list: readonly WardrobeChange[]) => list.map((c) =>
    `${nameOf(c, cast)}: ${c.wardrobe} (${c.mode === "within" ? "changes during this scene" : "already wearing it as the scene opens"})`,
  ).join("\n") || "(no change at this scene)";
  if (edit.wardrobe) changes.push({ field: "wardrobe", before: wardrobe(before), after: wardrobe(edit.wardrobe) });
  return changes;
}

/**
 * Propose card corrections for the picked scenes from one piece of feedback.
 *
 * Nothing is saved. Scenes are worked in story order on a copy of the record,
 * so a later scene sees the corrected card before it and the wardrobe an
 * earlier correction carried forward.
 */
export async function previewCardFeedback(projectId: string, raw: unknown): Promise<CardFeedbackPreview> {
  const request = cardFeedbackRequestSchema.parse(raw);
  await assertIdle(projectId);
  const provider = getPlanningProvider();
  if (!provider) {
    throw new PrerequisiteError("Feedback refinement requires AI planning and a configured planning model. Configure the LLM connection first.");
  }
  if (getAgentRun(projectId)) throw new PrerequisiteError("A planning run is already in progress.");
  return trackAgentRun(projectId, "scene_feedback", "Scene card feedback", async () => {
    const record = await getProjectRecord(projectId);
    const all = record.storyboard?.scenes;
    if (!all) throw new ValidationError("Generate a storyboard before correcting scene cards.");
    const missing = request.sceneIds.find((id) => !all.some((scene) => scene.id === id));
    if (missing) throw new NotFoundError(`Scene ${missing} not found`);
    const cast = await resolveProjectCast(record.project);
    const picked = new Set(request.sceneIds);
    const order = all.filter((scene) => picked.has(scene.id)).sort((a, b) => a.sceneNumber - b.sceneNumber);

    let working = record;
    const preview: CardFeedbackPreview = { sourceHash: cardSourceHash(record, cast), scenes: [], failed: [], warnings: [] };
    for (const { id: sceneId, sceneNumber } of order) {
      try {
        const scene = working.storyboard!.scenes.find((s) => s.id === sceneId)!;
        const existingWardrobe = working.project.wardrobeChanges?.[sceneId] ?? [];
        const { proposal, edit } = await proposeCardFeedback({
          scene,
          feedback: request.feedback,
          context: cardContext(working, sceneId, cast),
          project: { concept: record.project.concept, style: record.project.style, tone: record.project.tone },
          cast,
          existingWardrobe,
          provider,
        });
        working = withCardEdits(working, cast, [edit]);
        preview.scenes.push({
          sceneId, sceneNumber, summary: proposal.summary, edit,
          changes: describeEdit(scene, existingWardrobe, edit, proposal, cast),
        });
      } catch (error) {
        if (error instanceof ZodError) {
          preview.failed.push({ sceneId, sceneNumber, error: error.issues[0]?.message ?? "The proposal was invalid." });
        } else if (error instanceof ValidationError) {
          preview.failed.push({ sceneId, sceneNumber, error: error.message });
        } else {
          throw error;
        }
      }
    }

    const accepted = new Set(preview.scenes.map((s) => s.sceneId));
    const before = wardrobeTimeline(record.project, all, cast, record.storyboard!.visualBible);
    const after = wardrobeTimeline(working.project, working.storyboard!.scenes, cast, working.storyboard!.visualBible);
    const carriedInto = all.filter((scene) => !accepted.has(scene.id) &&
      JSON.stringify(before.get(scene.id)) !== JSON.stringify(after.get(scene.id)));
    if (carriedInto.length) {
      preview.warnings.push(
        `The wardrobe changes carry forward into scene${carriedInto.length === 1 ? "" : "s"} ` +
        `${carriedInto.map((s) => s.sceneNumber).join(", ")}, which ${carriedInto.length === 1 ? "is" : "are"} not rewritten. ` +
        "Use Repair prompts on the storyboard to update their appended wardrobe, and check their prompts don't still describe the old clothes.",
      );
    }
    logEvent("card_feedback.previewed", {
      projectId,
      scenes: preview.scenes.length,
      changed: preview.scenes.filter((s) => s.changes.length).length,
      failed: preview.failed.length,
    });
    return preview;
  });
}

/**
 * Save the previewed card corrections together, then rewrite the ticked
 * prompts of those scenes from the corrected cards.
 *
 * The cards are saved even if the rewrite then fails: they are the correction
 * the person approved, and an empty-feedback rewrite can be run again.
 */
export async function applyCardFeedback(projectId: string, raw: unknown): Promise<CardFeedbackApplyResult> {
  const body = cardFeedbackApplySchema.parse(raw);
  await assertIdle(projectId);
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before correcting scene cards.");
  const cast = await resolveProjectCast(record.project);
  if (cardSourceHash(record, cast) !== body.sourceHash) {
    throw new PrerequisiteError("The project changed after this preview. Preview again before applying; nothing was saved.");
  }
  const scenes = record.storyboard.scenes;
  const missing = body.edits.find((edit) => !scenes.some((scene) => scene.id === edit.sceneId));
  if (missing) throw new NotFoundError(`Scene ${missing.sceneId} not found`);
  if (new Set(body.edits.map((e) => e.sceneId)).size !== body.edits.length) {
    throw new ValidationError("Each scene may appear once.");
  }
  const known = new Set(cast.map((c) => c.id));
  const stranger = body.edits.flatMap((e) => e.wardrobe ?? []).find((c) => c.characterId && !known.has(c.characterId));
  if (stranger) throw new ValidationError(`${stranger.characterId} is not in this project's cast`);

  const numbers = (edits: readonly CardEdit[]) => edits
    .map((e) => scenes.find((s) => s.id === e.sceneId)!.sceneNumber)
    .sort((a, b) => a - b)
    .map((n) => `Scene ${n}`)
    .join(", ");
  const cards = body.edits.filter((e) => e.card);
  const wardrobe = body.edits.filter((e) => e.wardrobe);
  if (cards.length || wardrobe.length) {
    let updated = withCardEdits(record, cast, body.edits);
    updated = { ...updated, project: { ...updated.project, updatedAt: new Date().toISOString() } };
    if (cards.length) updated = { ...updated, history: appendHistory(updated, "scene.card_edited", `Feedback — ${numbers(cards)}`) };
    if (wardrobe.length) updated = { ...updated, history: appendHistory(updated, "scene.wardrobe_changed", `Feedback — ${numbers(wardrobe)}`) };
    await repository.update(projectId, updated);
  }
  logEvent("card_feedback.applied", {
    projectId,
    cards: cards.map((e) => e.sceneId),
    wardrobe: wardrobe.map((e) => e.sceneId),
    targets: [...body.targets],
  });

  try {
    const rewritten = await regenerateScenesPrompts(projectId, body.edits.map((e) => e.sceneId), rewriteOptionsFor(body.targets));
    return { record: rewritten, promptsRewritten: true };
  } catch (error) {
    return {
      record: await getProjectRecord(projectId),
      promptsRewritten: false,
      promptError: `The scene cards were saved, but rewriting their prompts failed: ${error instanceof Error ? error.message : "unknown error"}. Rewrite them with the feedback box empty to try again.`,
    };
  }
}
