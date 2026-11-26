import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { writeSceneDialogue } from "@/lib/agents/dialogue-agent";
import { lintDialogue } from "@/lib/agents/media-prompt-spec";
import { storedPromptWarnings, storedSceneImageContext } from "@/lib/agents/prompt-validation";
import { repository } from "@/lib/db/store";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { appendExecution, type ArtifactExecution } from "@/lib/schemas/provenance";
import { dialogueModeSchema, type ProjectRecord, type Scene } from "@/lib/schemas/storyboard";
import { trackAgentRun } from "@/lib/services/agent-runs";
import { resolveProjectCast } from "@/lib/services/character-service";
import { appendHistory, getProjectRecord, regenerateScenesPrompts } from "@/lib/services/project-service";
import { assertIdle } from "@/lib/services/scene-feedback-service";
import { logEvent } from "@/lib/telemetry";

/**
 * Rewrite the dialogue of chosen scenes on demand, without touching their
 * pictures.
 *
 * Before this the only ways to lengthen a scene's speech were typing it by hand
 * or regenerating the whole storyboard, which throws away every keyframe.
 */

export const dialogueRewriteRequestSchema = z.object({
  /** Omitted or empty means every scene, narrowed by `onlyUnderCovered`. */
  sceneIds: z.array(z.string().min(1)).max(500).optional(),
  /** Only the scenes whose dialogue currently fails its mode's length check. */
  onlyUnderCovered: z.boolean().optional(),
  /** Applied to every targeted scene and kept: the writer may not demote it. */
  modeOverride: dialogueModeSchema.optional(),
  /** The creator's note, passed to the writer as data. */
  instruction: z.string().trim().max(500).optional(),
  /** Also rewrite the video prompts of the scenes that changed. Image prompts are never touched. */
  rewriteVideoPrompts: z.boolean().optional(),
}).strict();
export type DialogueRewriteRequest = z.infer<typeof dialogueRewriteRequestSchema>;

export type DialogueRewriteResult = {
  record: ProjectRecord;
  updatedSceneIds: string[];
  skippedSceneIds: string[];
  /** Length warnings still standing on rewritten scenes, by scene id. */
  warnings: Record<string, string[]>;
  promptsRewritten: boolean;
  promptError?: string;
};

function seconds(scene: Scene): number {
  return scene.trimAtEndSeconds ?? scene.targetDurationSeconds;
}

function underCovered(scene: Scene): boolean {
  return lintDialogue(scene.dialogue ?? [], seconds(scene), {
    mode: scene.dialogueMode,
    narrationText: scene.narrationText,
  }).some((finding) => finding.code === "dialogue_under_budget");
}

function sameDialogue(a: Scene, b: Pick<Scene, "dialogue" | "dialogueMode">): boolean {
  return JSON.stringify(a.dialogue ?? []) === JSON.stringify(b.dialogue ?? []) && a.dialogueMode === b.dialogueMode;
}

export async function rewriteDialogue(projectId: string, raw: unknown): Promise<DialogueRewriteResult> {
  const request = dialogueRewriteRequestSchema.parse(raw ?? {});
  await assertIdle(projectId);

  // Keyed as a storyboard run, like the prompt rewrites, so the canvas shows the
  // storyboard as busy and recovery treats it the same way.
  const outcome = await trackAgentRun(projectId, "storyboard", "Dialogue Writer", async () => {
    const record = await getProjectRecord(projectId);
    if (!record.storyboard) throw new ValidationError("Generate a storyboard before rewriting dialogue");
    const scenes = record.storyboard.scenes;
    const requested = request.sceneIds?.length ? [...new Set(request.sceneIds)] : scenes.map((s) => s.id);
    const missing = requested.find((id) => !scenes.some((scene) => scene.id === id));
    if (missing) throw new NotFoundError(`Scene ${missing} not found`);

    const targets = scenes.filter((scene) =>
      requested.includes(scene.id) && (!request.onlyUnderCovered || underCovered(scene)));
    if (!targets.length) {
      return { record, updatedSceneIds: [], skippedSceneIds: requested, warnings: {} };
    }

    const cast = await resolveProjectCast(record.project);
    const executions: ArtifactExecution[] = [];
    const correlationId = randomUUID();
    const pass = await writeSceneDialogue(
      scenes.map(({ prompts: _prompts, ...draft }) => draft),
      {
        project: record.project,
        provider: getPlanningProvider(),
        cast,
        visualBible: record.storyboard.visualBible,
        plans: {
          worldBible: record.worldBible,
          directorialPlan: record.directorialPlan,
          cinematographyPlan: record.cinematographyPlan,
          artDirectionPlan: record.artDirectionPlan,
        },
        onExecution: (execution) => executions.push(execution),
        correlationId,
      },
      {
        only: new Set(targets.map((scene) => scene.id)),
        force: true,
        ...(request.modeOverride ? { modeOverride: request.modeOverride } : {}),
        ...(request.instruction ? { instruction: request.instruction } : {}),
      },
    );

    const written = new Map(pass.scenes.map((scene) => [scene.id, scene]));
    const updatedSceneIds = targets
      .filter((scene) => !sameDialogue(scene, written.get(scene.id)!))
      .map((scene) => scene.id);
    const changed = new Set(updatedSceneIds);
    const merged = scenes.map((scene) => {
      if (!changed.has(scene.id)) return scene;
      const next = written.get(scene.id)!;
      return { ...scene, dialogue: next.dialogue, dialogueMode: next.dialogueMode };
    });
    const withWarnings = merged.map((scene) => changed.has(scene.id)
      ? {
          ...scene,
          prompts: {
            ...scene.prompts,
            promptWarnings: storedPromptWarnings(scene, storedSceneImageContext(
              record.project, scene, cast, record.storyboard!.visualBible, merged,
            )),
          },
        }
      : scene);

    const numbers = targets.map((scene) => `Scene ${scene.sceneNumber}`).join(", ");
    const updated: ProjectRecord = {
      ...record,
      storyboard: { ...record.storyboard, scenes: withWarnings },
      executions: executions.reduce<ArtifactExecution[] | undefined>(
        (all, next) => appendExecution(all, next),
        record.executions,
      ),
      project: { ...record.project, updatedAt: new Date().toISOString() },
      history: appendHistory(record, "scene.dialogue_rewritten", numbers),
    };
    await repository.update(projectId, updated);
    logEvent("dialogue.rewritten", {
      projectId,
      requested: requested.length,
      targeted: targets.length,
      updated: updatedSceneIds.length,
      modeOverride: request.modeOverride ?? null,
      withInstruction: Boolean(request.instruction),
    });
    return {
      record: updated,
      updatedSceneIds,
      skippedSceneIds: requested.filter((id) => !changed.has(id)),
      warnings: Object.fromEntries(Object.entries(pass.warnings).filter(([id]) => changed.has(id))),
    };
  });

  if (!request.rewriteVideoPrompts || !outcome.updatedSceneIds.length) {
    return { ...outcome, promptsRewritten: false };
  }
  // Only the clip prompt speaks the lines; the stills, their seeds and any
  // rendered keyframes stay exactly as they are.
  try {
    const record = await regenerateScenesPrompts(projectId, outcome.updatedSceneIds, { passes: ["video"] });
    return { ...outcome, record, promptsRewritten: true };
  } catch (error) {
    return {
      ...outcome,
      record: await getProjectRecord(projectId),
      promptsRewritten: false,
      promptError: `The dialogue was saved, but rewriting the video prompts failed: ${error instanceof Error ? error.message : "unknown error"}. Rewrite the video prompts to try again.`,
    };
  }
}
