import { randomUUID } from "node:crypto";
import { createProjectSchema, updateProjectModelsSchema } from "@/lib/schemas/intake";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
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
    modelStrategy: input.modelStrategy,
    imageModel: input.imageModel,
    videoModel: input.videoModel,
    useCharacterLibrary: input.useCharacterLibrary,
    characterIds: input.useCharacterLibrary ? input.characterIds : [],
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

  const updated: ProjectRecord = {
    ...record,
    project: {
      ...record.project,
      imageModel: resolve(patch.imageModel, record.project.imageModel),
      videoModel: resolve(patch.videoModel, record.project.videoModel),
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
  });
  return updated;
}

export async function listProjects(): Promise<Project[]> {
  const records = await repository.list();
  return records.map((r) => r.project);
}

export async function getProjectRecord(id: string): Promise<ProjectRecord> {
  const record = await repository.get(id);
  if (!record) throw new NotFoundError(`Project ${id} not found`);
  return record;
}

export async function generateStoryboard(id: string): Promise<ProjectRecord> {
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
  const snapshot = await runStoryboardOrchestrator(record.project, {
    selectedVariant,
    cast,
    plans,
  });
  const updated: ProjectRecord = {
    ...record,
    project: { ...record.project, status: "storyboard_ready", updatedAt: new Date().toISOString() },
    storyboard: snapshot,
    history: appendHistory(record, "storyboard.generated", selectedVariant?.name),
  };
  await repository.update(id, updated);
  return updated;
}

export async function generateVariants(id: string): Promise<ProjectRecord> {
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

export async function generateWorldBible(id: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  const worldBible: WorldBible = await worldBuilderAgent(record.project, getPlanningProvider());
  const updated: ProjectRecord = {
    ...record,
    worldBible,
    history: appendHistory(record, "world_bible.generated"),
  };
  await repository.update(id, updated);
  return updated;
}

export async function generateDirectorialPlan(id: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  const directorialPlan: DirectorialPlan = await directorAgent(record.project, getPlanningProvider());
  const updated: ProjectRecord = {
    ...record,
    directorialPlan,
    history: appendHistory(record, "directorial_plan.generated"),
  };
  await repository.update(id, updated);
  return updated;
}

export async function generateCinematographyPlan(id: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  const cinematographyPlan: CinematographyPlan = await cinematographerAgent(
    record.project,
    getPlanningProvider(),
  );
  const updated: ProjectRecord = {
    ...record,
    cinematographyPlan,
    history: appendHistory(record, "cinematography_plan.generated"),
  };
  await repository.update(id, updated);
  return updated;
}

export async function generateArtDirectionPlan(id: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(id);
  const artDirectionPlan: ArtDirectionPlan = await artDirectorAgent(record.project, getPlanningProvider());
  const updated: ProjectRecord = {
    ...record,
    artDirectionPlan,
    history: appendHistory(record, "art_direction_plan.generated"),
  };
  await repository.update(id, updated);
  return updated;
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
  const record = await getProjectRecord(id);
  const audioPlan = await audioDirectorAgent(record.project, audioScenesFor(record), getPlanningProvider());
  const updated: ProjectRecord = {
    ...record,
    audioPlan,
    history: appendHistory(record, "audio_plan.generated"),
  };
  await repository.update(id, updated);
  return updated;
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

export async function deleteProject(id: string): Promise<void> {
  const ok = await repository.delete(id);
  if (!ok) throw new NotFoundError(`Project ${id} not found`);
}
