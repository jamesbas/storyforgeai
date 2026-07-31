import { randomUUID } from "node:crypto";
import { createProjectSchema, renameProjectSchema, updateProjectModelsSchema } from "@/lib/schemas/intake";
import { computeSegmentation } from "@/lib/duration";
import { DEFAULT_SCENE_CONTINUITY, generationStages } from "@/lib/types";
import type { ProjectStatus } from "@/lib/types";
import {
  pruneSceneLoras,
  pruneSelectionSet,
  resolvePinnedModels,
  validateSelectionSet,
} from "@/lib/services/lora-service";
import type { Project } from "@/lib/schemas/project";
import { sceneFramingPatchSchema, scenePromptsPatchSchema } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type {
  ArtDirectionPlan,
  CinematographyPlan,
  CreativeVariant,
  DirectorialPlan,
  HistoryEntry,
  WorldBible,
} from "@/lib/schemas/canvas";
import { repository } from "@/lib/db/store";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import { intakeAgent } from "@/lib/agents/intake-agent";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import type { AgentContext } from "@/lib/agents/types";
import type { StoryPlan } from "@/lib/schemas/agents";
import { deriveTitle } from "@/lib/agents/mock-agents";
import {
  artDirectorAgent,
  cinematographerAgent,
  directorAgent,
  variantExplorerAgent,
  worldBuilderAgent,
} from "@/lib/agents/canvas-agents";
import { audioDirectorAgent } from "@/lib/agents/audio-agents";
import type { AudioSceneRef } from "@/lib/agents/mock-audio";
import { buildAnimaticPlan } from "@/lib/agents/mock-audio";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { resolveProjectCast } from "@/lib/services/character-service";
import { trackAgentRun } from "@/lib/services/agent-runs";
import { planOn, planSpecFor } from "@/lib/agents/plan-fields";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

/**
 * Project service — all business logic for the project lifecycle. Route handlers
 * stay thin and delegate here (generic-build-spec Section 2.3).
 */

function appendHistory(record: ProjectRecord, action: string, detail?: string): HistoryEntry[] {
  const entry: HistoryEntry = { at: new Date().toISOString(), action, detail };
  return [...(record.history ?? []), entry];
}

export async function createProject(raw: unknown): Promise<Project> {
  const input = createProjectSchema.parse(raw);
  const seg = computeSegmentation(input.requestedDurationSeconds, input.segmentSeconds);
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    title: deriveTitle(input.concept),
    concept: input.concept,
    requestedDurationSeconds: input.requestedDurationSeconds,
    segmentSeconds: seg.segmentSeconds,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: input.aspectRatio,
    resolutionPreset: input.resolutionPreset,
    style: input.style,
    tone: input.tone,
    audience: input.audience,
    creativeMode: input.creativeMode,
    narrationRequired: input.narrationRequired,
    dialogueRequired: input.dialogueRequired,
    musicRequired: input.musicRequired,
    sfxRequired: input.sfxRequired,
    generationMode: input.generationMode,
    qcEnabled: input.qcEnabled,
    modelStrategy: input.modelStrategy,
    imageModel: input.imageModel,
    videoModel: input.videoModel,
    useCharacterLibrary: input.useCharacterLibrary,
    characterIds: input.useCharacterLibrary ? input.characterIds : [],
    characterWardrobe: input.useCharacterLibrary ? input.characterWardrobe : {},
    sceneContinuity: input.sceneContinuity,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  await repository.create({ project });
  logEvent("project.created", {
    id: project.id,
    segmentCount: seg.segmentCount,
    segmentSeconds: seg.segmentSeconds,
  });
  return project;
}

/**
 * Change the WanGP model pins for a project.
 *
 * Only future generations are affected, so this stays editable at any point in
 * the lifecycle. Passing null clears a pin and returns the project to automatic
 * selection. An empty string is treated as null so a "use automatic" option in
 * a <select> needs no special casing.
 */
export async function updateProjectModels(id: string, raw: unknown): Promise<ProjectRecord> {
  const patch = updateProjectModelsSchema.parse(raw);
  const record = await getProjectRecord(id);

  const resolve = (next: string | null | undefined, current: string | undefined) => {
    if (next === undefined) return current;
    return next === null || next === "" ? undefined : next;
  };

  // Null clears an override and hands the decision back to `resolveSteps`.
  const resolveSteps = (next: number | null | undefined, current: number | undefined) =>
    next === undefined ? current : (next ?? undefined);

  const imageModel = resolve(patch.imageModel, record.project.imageModel);
  const videoModel = resolve(patch.videoModel, record.project.videoModel);
  const modelsChanged =
    imageModel !== record.project.imageModel || videoModel !== record.project.videoModel;

  /**
   * A LoRA is only meaningful for the model it was trained against, so a
   * selection has to be checked whenever it — or the model under it — changes.
   *
   * The two cases are handled differently on purpose. An explicit selection is
   * validated strictly: the user is choosing right now, so an unknown name is
   * an actionable error. A selection that merely got stranded by a model change
   * is pruned instead, because refusing the model change over it would be
   * backwards.
   */
  const currentLoras = record.project.loras;
  let loras = patch.loras ?? currentLoras;
  if (patch.loras) {
    loras = await validateSelectionSet(patch.loras, await resolvePinnedModels({ imageModel, videoModel }));
  } else if (modelsChanged && (currentLoras?.image.length || currentLoras?.video.length)) {
    loras = await pruneSelectionSet(
      currentLoras,
      await resolvePinnedModels({ imageModel, videoModel }),
      { projectId: id },
    );
  }

  const updated: ProjectRecord = {
    ...record,
    project: {
      ...record.project,
      imageModel,
      videoModel,
      imageSteps: resolveSteps(patch.imageSteps, record.project.imageSteps),
      videoSteps: resolveSteps(patch.videoSteps, record.project.videoSteps),
      generationMode: patch.generationMode ?? record.project.generationMode,
      qcEnabled: patch.qcEnabled ?? record.project.qcEnabled,
      resolutionPreset: patch.resolutionPreset ?? record.project.resolutionPreset,
      sceneContinuity: patch.sceneContinuity ?? record.project.sceneContinuity,
      characterWardrobe: patch.characterWardrobe ?? record.project.characterWardrobe,
      loras,
      sceneLoras: pruneSceneLoras(
        patch.sceneLoras ?? record.project.sceneLoras,
        (record.storyboard?.scenes ?? []).map((scene) => scene.id),
      ),
      updatedAt: new Date().toISOString(),
    },
    history: appendHistory(record, "project.models_updated"),
  };

  await repository.update(id, updated);
  logEvent("project.updated", {
    id,
    change: "models",
    imageModel: updated.project.imageModel ?? "auto",
    videoModel: updated.project.videoModel ?? "auto",
    sceneContinuity: updated.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY,
  });
  return updated;
}

/**
 * Rename a project.
 *
 * The title is only ever a label — it is derived from the concept at creation
 * and read by nothing downstream — so this is a pure metadata edit with no
 * regeneration consequences.
 */
export async function renameProject(id: string, raw: unknown): Promise<ProjectRecord> {
  const { title } = renameProjectSchema.parse(raw);
  const record = await getProjectRecord(id);

  const updated: ProjectRecord = {
    ...record,
    project: { ...record.project, title, updatedAt: new Date().toISOString() },
    history: appendHistory(record, "project.renamed", title),
  };
  await repository.update(id, updated);
  logEvent("project.updated", { id, change: "title" });
  return updated;
}

/**
 * Copy a project's plan, without its renders.
 *
 * The point of a copy is to re-run the same story against different models,
 * LoRAs or continuity settings, so everything that describes *intent* comes
 * across — settings, variants, the canvas plans, the storyboard and its prompts
 * — while everything that is the *result* of a render does not. Carrying
 * attempts over would attach one project's media to another and make the
 * assembled cut of the copy indistinguishable from the original's.
 *
 * Scene ids embed the project id, so they are remapped, and every map keyed by
 * scene id is rewritten to match. A stale key here would silently strand a
 * scene's pinned seed or LoRA override.
 */
export async function duplicateProject(id: string): Promise<Project> {
  const source = await getProjectRecord(id);
  const now = new Date().toISOString();
  const newId = randomUUID();

  const sceneIdMap = new Map<string, string>();
  for (const scene of source.storyboard?.scenes ?? []) {
    sceneIdMap.set(scene.id, `${newId}-scene-${String(scene.sceneNumber).padStart(3, "0")}`);
  }
  const remap = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!map) return undefined;
    const next: Record<string, T> = {};
    for (const [sceneId, value] of Object.entries(map)) {
      const mapped = sceneIdMap.get(sceneId);
      if (mapped) next[mapped] = value;
    }
    return Object.keys(next).length ? next : undefined;
  };

  const project: Project = {
    ...source.project,
    id: newId,
    title: copyTitle(source.project.title),
    // Seeds carry over so the copy renders the same images unless something is
    // deliberately changed — which is the whole point of comparing two runs.
    sceneSeeds: remap(source.project.sceneSeeds),
    sceneLoras: remap(source.project.sceneLoras),
    status: source.storyboard ? "storyboard_ready" : "draft",
    createdAt: now,
    updatedAt: now,
  };

  const record: ProjectRecord = {
    project,
    variants: source.variants,
    selectedVariantId: source.selectedVariantId,
    worldBible: source.worldBible,
    directorialPlan: source.directorialPlan,
    cinematographyPlan: source.cinematographyPlan,
    artDirectionPlan: source.artDirectionPlan,
    storyboard: source.storyboard
      ? {
          ...source.storyboard,
          scenes: source.storyboard.scenes.map((scene) => ({
            ...scene,
            id: sceneIdMap.get(scene.id) ?? scene.id,
            projectId: newId,
            status: "planned",
          })),
        }
      : undefined,
    history: [{ at: now, action: "project.copied", detail: source.project.title }],
  };

  await repository.create(record);
  logEvent("project.created", {
    id: newId,
    copiedFrom: id,
    segmentCount: project.segmentCount,
    segmentSeconds: project.segmentSeconds,
  });
  return project;
}

/** "Name" → "Name (copy)", "Name (copy)" → "Name (copy 2)". */
function copyTitle(title: string): string {
  const match = /^(.*) \(copy(?: (\d+))?\)$/.exec(title);
  if (!match) return `${title} (copy)`;
  return `${match[1]} (copy ${Number(match[2] ?? 1) + 1})`;
}

/**
 * What state a project is actually in, worked out from what it holds.
 *
 * `project.status` is written at three points and never reconciled: media
 * generation sets it to `generating` and nothing ever sets it back, so a
 * finished project reads as still running for the rest of its life. Deriving it
 * from the record cannot drift, because there is nothing to keep in step.
 */
export function derivedStatus(record: ProjectRecord, generating: boolean): ProjectStatus {
  if (record.project.status === "failed") return "failed";
  if (record.assembly) return "assembled";
  const scenes = record.storyboard?.scenes ?? [];
  if (!scenes.length) return "draft";
  if (generating) return "generating";

  const attemptsFor = (id: string) => record.attempts?.[id] ?? [];
  const withMedia = scenes.filter((s) => attemptsFor(s.id).length > 0);
  if (!withMedia.length) return "storyboard_ready";
  if (scenes.every((s) => attemptsFor(s.id).some((a) => a.approved))) return "approved";
  return "needs_review";
}

export async function listProjects(): Promise<Project[]> {
  const records = await repository.list();
  // Lazily imported: the scene queue reads projects back through this module.
  const { getQueue } = await import("@/lib/services/scene-queue");
  return records.map((r) => ({
    ...r.project,
    status: derivedStatus(r, getQueue(r.project.id).active),
  }));
}

export async function getProjectRecord(id: string): Promise<ProjectRecord> {
  const record = await repository.get(id);
  if (!record) throw new NotFoundError(`Project ${id} not found`);
  return record;
}

export async function generateStoryboard(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "storyboard", "Storyboard Artist", async () => {
    const record = await getProjectRecord(id);
    const selectedVariant = record.variants?.find((v) => v.id === record.selectedVariantId);
    // Read the cast at generation time rather than at creation time, so editing a
    // character in the library and regenerating picks up the new description.
    const cast = await resolveProjectCast(record.project);
    // Whichever canvas plans have been generated and approved steer the pipeline.
    // Each is optional: the canvas agents run on demand, so a project may have
    // none, some, or all of them.
    const plans = {
      worldBible: record.worldBible,
      directorialPlan: record.directorialPlan,
      cinematographyPlan: record.cinematographyPlan,
      artDirectionPlan: record.artDirectionPlan,
    };
    let freshStoryPlan: StoryPlan | undefined;
    const snapshot = await runStoryboardOrchestrator(record.project, {
      selectedVariant,
      cast,
      plans,
      storyPlan: record.storyPlan,
      onStoryPlan: (plan) => {
        freshStoryPlan = plan;
      },
    });
    const updated: ProjectRecord = {
      ...record,
      project: { ...record.project, status: "storyboard_ready", updatedAt: new Date().toISOString() },
      storyPlan: freshStoryPlan ?? record.storyPlan,
      storyboard: snapshot,
      history: appendHistory(record, "storyboard.generated", selectedVariant?.name),
    };
    await repository.update(id, updated);
    await autoStartMedia(updated);
    return updated;
  });
}

/**
 * Queue the whole storyboard when the project asked for `full_auto`.
 *
 * This is the only thing that distinguishes full auto from video segments at
 * plan time, and it is what the mode has always claimed to do. Failures are
 * swallowed: the storyboard is generated either way, and the user can still
 * press the button.
 *
 * Imported lazily because the scene queue reads projects back through this
 * module, and a static import would close the cycle.
 */
async function autoStartMedia(record: ProjectRecord): Promise<void> {
  if (!generationStages(record.project.generationMode).autoStart) return;
  try {
    const { enqueueProjectScenes } = await import("@/lib/services/scene-queue");
    const queued = await enqueueProjectScenes(record.project.id);
    logEvent("scene_queue.enqueued", {
      projectId: record.project.id,
      scenes: queued.length,
      trigger: "full_auto",
    });
  } catch {
    // Best effort. The storyboard is already saved and the button still works.
  }
}

export async function generateVariants(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "variants", "Variant Explorer", async () => {
    const record = await getProjectRecord(id);
    const provider = getPlanningProvider();
    const variants = await variantExplorerAgent(record.project, provider);
    const updated: ProjectRecord = {
      ...record,
      variants,
      selectedVariantId: undefined,
      history: appendHistory(record, "variants.generated", `${variants.length} directions`),
    };
    await repository.update(id, updated);
    logEvent("agent.run", { projectId: id, agent: "variant_explorer", count: variants.length });
    return updated;
  });
}

export async function selectVariant(id: string, variantId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  const variants = record.variants ?? [];
  const target = variants.find((v) => v.id === variantId);
  if (!target) throw new NotFoundError(`Variant ${variantId} not found`);
  const updated: ProjectRecord = {
    ...record,
    variants: variants.map((v) => ({ ...v, selected: v.id === variantId })),
    selectedVariantId: variantId,
    history: appendHistory(record, "variant.selected", target.name),
  };
  await repository.update(id, updated);
  return updated;
}

/**
 * Hand-edit a scene's prompts.
 *
 * The scene prompts are what is actually sent to WanGP, so being able to correct
 * them without regenerating the whole storyboard is the difference between
 * nudging one shot and rewriting the project. Edits are written into the
 * storyboard snapshot rather than held beside it, which keeps the invariant that
 * the Prompts panel shows exactly what will be generated.
 *
 * Regenerating the storyboard replaces them, which is why the UI says so.
 */
export async function updateSceneFraming(
  id: string,
  sceneId: string,
  raw: unknown,
): Promise<ProjectRecord> {
  const patch = sceneFramingPatchSchema.parse(raw);
  const record = await getProjectRecord(id);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before editing framing");

  const scene = record.storyboard.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);

  const updated: ProjectRecord = {
    ...record,
    storyboard: {
      ...record.storyboard,
      scenes: record.storyboard.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: appendHistory(record, "scene.framing_edited", `Scene ${scene.sceneNumber}`),
  };

  await repository.update(id, updated);
  logEvent("project.updated", { id, change: "scene_framing", sceneId });
  return updated;
}

export async function updateScenePrompts(
  id: string,
  sceneId: string,
  raw: unknown,
): Promise<ProjectRecord> {
  const patch = scenePromptsPatchSchema.parse(raw);
  const record = await getProjectRecord(id);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before editing prompts");

  const scene = record.storyboard.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);

  const updated: ProjectRecord = {
    ...record,
    storyboard: {
      ...record.storyboard,
      scenes: record.storyboard.scenes.map((s) =>
        s.id === sceneId ? { ...s, prompts: { ...s.prompts, ...patch } } : s,
      ),
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: appendHistory(record, "scene.prompts_edited", `Scene ${scene.sceneNumber}`),
  };

  await repository.update(id, updated);
  logEvent("project.updated", { id, change: "scene_prompts", sceneId });
  return updated;
}

/**
 * Overwrite the editable fields of one agent's plan.
 *
 * Only the fields the plan declares as editable are taken from the caller, and
 * `projectId` is stamped from the record rather than accepted — the same rule
 * that keeps a model from authoring derived values applies to a browser.
 *
 * The history entry matters beyond the log: the Storyboard screen decides
 * whether a plan is "not applied yet" by comparing its last action to the last
 * storyboard generation, so without one an edit would never reach a render
 * while the badge still claimed the plan applied.
 */
export async function updatePlan(
  id: string,
  agentKey: string,
  patch: unknown,
): Promise<ProjectRecord> {
  const spec = planSpecFor(agentKey);
  if (!spec) throw new NotFoundError(`No editable plan for ${agentKey}`);

  const record = await getProjectRecord(id);
  const current = planOn(record, spec);
  if (!current) throw new ValidationError(`Run the ${spec.label} agent before editing it`);
  if (!patch || typeof patch !== "object") throw new ValidationError("Expected an object of fields");

  const incoming = patch as Record<string, unknown>;
  const editable: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (field.key in incoming) editable[field.key] = incoming[field.key];
  }

  const merged = { ...current, ...editable, projectId: record.project.id };
  const parsed = spec.schema.safeParse(merged);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  const updated: ProjectRecord = {
    ...record,
    [spec.recordKey]: parsed.data,
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: appendHistory(record, spec.historyAction, "edited by hand"),
  };

  await repository.update(id, updated);
  logEvent("project.updated", { id, change: "plan", plan: spec.recordKey });
  return updated;
}

/**
 * Guarantee the project has a narrative arc.
 *
 * The Director is asked to convert "the selected concept and story arc", and
 * writes `sceneIntent` keyed by scene — but the canvas runs before the
 * storyboard exists, so without this it is inventing beats and guessing at
 * segment numbers. Generating the arc here makes its per-scene direction real,
 * and `generateStoryboard` then reuses it rather than paying for it twice.
 */
async function withStoryPlan(record: ProjectRecord): Promise<ProjectRecord> {
  if (record.storyPlan) return record;

  const provider = getPlanningProvider();
  const ctx: AgentContext = {
    project: record.project,
    cast: await resolveProjectCast(record.project),
    selectedVariant: record.variants?.find((v) => v.id === record.selectedVariantId),
  };
  ctx.brief = await intakeAgent(ctx, provider);
  const storyPlan = await storyArchitectAgent(ctx, provider);

  const updated: ProjectRecord = {
    ...record,
    storyPlan,
    history: appendHistory(record, "story_plan.generated"),
  };
  await repository.update(record.project.id, updated);
  return updated;
}

/**
 * What the canvas agents are given.
 *
 * Plans accumulate, so an agent run later sees the ones approved before it —
 * the Cinematographer lights the Director's intent instead of inventing a
 * second mood from the same one-line concept.
 */
async function canvasContext(record: ProjectRecord) {
  return {
    selectedVariant: record.variants?.find((v) => v.id === record.selectedVariantId),
    cast: await resolveProjectCast(record.project),
    storyPlan: record.storyPlan,
    plans: {
      worldBible: record.worldBible,
      directorialPlan: record.directorialPlan,
      cinematographyPlan: record.cinematographyPlan,
      artDirectionPlan: record.artDirectionPlan,
    },
  };
}

export async function generateWorldBible(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "world", "World Builder", async () => {
    const record = await getProjectRecord(id);
    const worldBible: WorldBible = await worldBuilderAgent(
      record.project,
      getPlanningProvider(),
      await canvasContext(record),
    );
    const updated: ProjectRecord = {
      ...record,
      worldBible,
      history: appendHistory(record, "world_bible.generated"),
    };
    await repository.update(id, updated);
    return updated;
  });
}

export async function generateDirectorialPlan(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "director", "Director", async () => {
    // The Director is the one canvas agent whose prompt names the story arc, so
    // it is the natural place to produce one when the project has none yet.
    const record = await withStoryPlan(await getProjectRecord(id));
    const directorialPlan: DirectorialPlan = await directorAgent(
      record.project,
      getPlanningProvider(),
      await canvasContext(record),
    );
    const updated: ProjectRecord = {
      ...record,
      directorialPlan,
      history: appendHistory(record, "directorial_plan.generated"),
    };
    await repository.update(id, updated);
    return updated;
  });
}

export async function generateCinematographyPlan(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "cinematographer", "Cinematographer", async () => {
    const record = await getProjectRecord(id);
    const cinematographyPlan: CinematographyPlan = await cinematographerAgent(
      record.project,
      getPlanningProvider(),
      await canvasContext(record),
    );
    const updated: ProjectRecord = {
      ...record,
      cinematographyPlan,
      history: appendHistory(record, "cinematography_plan.generated"),
    };
    await repository.update(id, updated);
    return updated;
  });
}

export async function generateArtDirectionPlan(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "art", "Art Director", async () => {
    const record = await getProjectRecord(id);
    const artDirectionPlan: ArtDirectionPlan = await artDirectorAgent(
      record.project,
      getPlanningProvider(),
      await canvasContext(record),
    );
    const updated: ProjectRecord = {
      ...record,
      artDirectionPlan,
      history: appendHistory(record, "art_direction_plan.generated"),
    };
    await repository.update(id, updated);
    return updated;
  });
}

export async function getVariants(id: string): Promise<CreativeVariant[]> {
  const record = await getProjectRecord(id);
  return record.variants ?? [];
}

function sceneIdsFor(record: ProjectRecord): string[] {
  if (record.storyboard) return record.storyboard.scenes.map((s) => s.id);
  return Array.from(
    { length: record.project.segmentCount },
    (_, i) => `${record.project.id}-scene-${String(i + 1).padStart(3, "0")}`,
  );
}

/** Scene context the Audio Director needs to place cues on a timeline. */
function audioScenesFor(record: ProjectRecord): AudioSceneRef[] {
  if (record.storyboard) {
    return record.storyboard.scenes.map((s) => ({
      id: s.id,
      sceneNumber: s.sceneNumber,
      durationSeconds: s.trimAtEndSeconds ?? s.targetDurationSeconds,
    }));
  }
  return sceneIdsFor(record).map((id, i) => ({
    id,
    sceneNumber: i + 1,
    durationSeconds: record.project.segmentSeconds,
  }));
}

export async function generateAudioPlan(id: string): Promise<ProjectRecord> {
  return trackAgentRun(id, "audio", "Audio Director", async () => {
    const record = await getProjectRecord(id);
    const audioPlan = await audioDirectorAgent(record.project, audioScenesFor(record), getPlanningProvider());
    const updated: ProjectRecord = {
      ...record,
      audioPlan,
      history: appendHistory(record, "audio_plan.generated"),
    };
    await repository.update(id, updated);
    return updated;
  });
}

export async function generateAnimatic(id: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  if (!record.storyboard) {
    throw new ValidationError("Generate a storyboard before creating an animatic");
  }
  const animaticPlan = buildAnimaticPlan(record);
  const updated: ProjectRecord = {
    ...record,
    animaticPlan,
    history: appendHistory(record, "animatic.generated", `${animaticPlan.frames.length} frames`),
  };
  await repository.update(id, updated);
  logEvent("assembly.completed", { projectId: id, kind: "animatic", frames: animaticPlan.frames.length });
  return updated;
}

/**
 * Delete a project.
 *
 * Generated media is removed with it by default: once the record is gone the
 * folder is unreachable from the UI, so leaving it behind is silent disk use
 * rather than a safety net. `keepMedia` is there for the case where the clips
 * are worth more than the project that produced them.
 *
 * Any queued scenes are cancelled first. A batch run holds the project id and
 * would otherwise keep working against a record that no longer exists, failing
 * scene by scene.
 */
export async function deleteProject(
  id: string,
  options: { keepMedia?: boolean } = {},
): Promise<void> {
  // Prove it exists before tearing anything down, so a bad id cannot cancel a
  // queue as a side effect of a 404.
  await getProjectRecord(id);

  // Imported here rather than at module scope: scene-queue already imports this
  // module for `getProjectRecord`, and a static edge back would close the cycle.
  const { cancelQueue } = await import("@/lib/services/scene-queue");
  const cancelled = cancelQueue(id);

  const ok = options.keepMedia ? await repository.delete(id) : await repository.purge(id);
  if (!ok) throw new NotFoundError(`Project ${id} not found`);

  logEvent("project.deleted", { id, keptMedia: Boolean(options.keepMedia), cancelledScenes: cancelled });
}
