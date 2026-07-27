import { randomUUID } from "node:crypto";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildImageManifest, buildVideoManifest, runToCompletion } from "@/lib/services/wangp-service";
import { resolveProjectCast } from "@/lib/services/character-service";
import { resolveReferenceImagePath } from "@/lib/db/character-store";
import { qcAgent } from "@/lib/agents/qc-agent";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

function findScene(record: ProjectRecord, sceneId: string): Scene {
  const scene = record.storyboard?.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);
  return scene;
}

function withSceneStatus(record: ProjectRecord, sceneId: string, status: Scene["status"]): ProjectRecord {
  if (!record.storyboard) return record;
  return {
    ...record,
    storyboard: {
      ...record.storyboard,
      scenes: record.storyboard.scenes.map((s) => (s.id === sceneId ? { ...s, status } : s)),
    },
  };
}

/**
 * Absolute reference-image paths for the characters this project pinned.
 *
 * Only characters that actually have an uploaded image contribute: a written
 * description alone already reaches the render through the prompt, and sending
 * an empty list would trip WanGP's "You must provide at least one Reference
 * Image" check. Resolved fresh each run so replacing a character's photo takes
 * effect on the next generation.
 */
async function resolveCastReferenceImages(record: ProjectRecord): Promise<string[]> {
  const cast = await resolveProjectCast(record.project);
  return cast
    .map((character) =>
      character.referenceImage ? resolveReferenceImagePath(character.referenceImage) : null,
    )
    .filter((filePath): filePath is string => filePath !== null);
}

/**
 * Generate media for a scene: start frame, end frame, and the segment video,
 * then run QC. Each call produces a new attempt (retry/regeneration) per spec
 * Section 8.2. Uses absolute-style mock paths from the WanGP client.
 */
export async function generateSceneMedia(projectId: string, sceneId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");
  const scene = findScene(record, sceneId);
  const modelStrategy = record.project.modelStrategy;
  const { imageModel, videoModel } = record.project;

  // Character reference images condition the two keyframes. The video model
  // then inherits that identity for free through image_start / image_end, so
  // references are deliberately not sent on the video job as well.
  const imageRefs = await resolveCastReferenceImages(record);

  const startManifest = await buildImageManifest({
    sceneId,
    purpose: "start_frame",
    prompt: scene.prompts.startFramePrompt,
    negativePrompt: scene.prompts.imageNegativePrompt,
    modelStrategy,
    modelType: imageModel,
    imageRefs,
  });
  const startJob = await runToCompletion(startManifest.settings);

  const endManifest = await buildImageManifest({
    sceneId,
    purpose: "end_frame",
    prompt: scene.prompts.endFramePrompt,
    negativePrompt: scene.prompts.imageNegativePrompt,
    modelStrategy,
    modelType: imageModel,
    imageRefs,
  });
  const endJob = await runToCompletion(endManifest.settings);

  const videoManifest = await buildVideoManifest({
    sceneId,
    prompt: scene.prompts.videoPromptSegment,
    negativePrompt: scene.prompts.videoNegativePrompt,
    imageStart: startJob.generatedFiles[0],
    imageEnd: endJob.generatedFiles[0],
    modelStrategy,
    modelType: videoModel,
    // The final scene is often shorter than a full segment.
    durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
  });
  const videoJob = await runToCompletion(videoManifest.settings);

  const existing = record.attempts?.[sceneId] ?? [];
  const attempt: SceneAttempt = {
    id: randomUUID(),
    sceneId,
    attemptNumber: existing.length + 1,
    startImagePath: startJob.generatedFiles[0],
    endImagePath: endJob.generatedFiles[0],
    videoPath: videoJob.generatedFiles[0],
    settingsIds: [startManifest.id, endManifest.id, videoManifest.id],
    approved: false,
    createdAt: new Date().toISOString(),
  };
  attempt.qcResult = await qcAgent(scene, attempt, getPlanningProvider());

  const nextStatus: Scene["status"] = attempt.qcResult.passed ? "generated" : "needs_review";
  let updated = withSceneStatus(record, sceneId, nextStatus);
  updated = {
    ...updated,
    attempts: { ...(updated.attempts ?? {}), [sceneId]: [...existing, attempt] },
    project: { ...updated.project, status: "generating", updatedAt: new Date().toISOString() },
    history: [
      ...(updated.history ?? []),
      { at: new Date().toISOString(), action: "scene.generated", detail: `${sceneId} #${attempt.attemptNumber}` },
    ],
  };

  await repository.update(projectId, updated);
  logEvent("scene.qc", { projectId, sceneId, passed: attempt.qcResult.passed });
  return updated;
}

export async function approveAttempt(
  projectId: string,
  sceneId: string,
  attemptId: string,
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const attempts = record.attempts?.[sceneId] ?? [];
  const target = attempts.find((a) => a.id === attemptId);
  if (!target) throw new NotFoundError(`Attempt ${attemptId} not found`);

  let updated = withSceneStatus(record, sceneId, "approved");
  updated = {
    ...updated,
    attempts: {
      ...(updated.attempts ?? {}),
      [sceneId]: attempts.map((a) => ({ ...a, approved: a.id === attemptId })),
    },
    history: [
      ...(updated.history ?? []),
      { at: new Date().toISOString(), action: "scene.approved", detail: sceneId },
    ],
  };
  await repository.update(projectId, updated);
  return updated;
}
