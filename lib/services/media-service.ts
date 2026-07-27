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

/** The attempt a scene is currently represented by: approved first, else latest. */
function chosenAttempt(record: ProjectRecord, sceneId: string): SceneAttempt | undefined {
  const attempts = record.attempts?.[sceneId] ?? [];
  return attempts.find((a) => a.approved) ?? attempts[attempts.length - 1];
}

type Continuity = {
  /** Reused start frame; when set, no start frame is rendered. */
  startImagePath?: string;
  /** Previous clip to continue from; when set, no keyframes are rendered. */
  videoSource?: string;
};

/**
 * Work out what this scene can inherit from the one before it.
 *
 * Falls back to a plain cut whenever the predecessor has not been generated
 * yet, so scenes can still be rendered out of order. Continuity is a saving and
 * a quality choice, never a prerequisite.
 */
function resolveContinuity(record: ProjectRecord, scene: Scene): Continuity {
  const mode = record.project.sceneContinuity ?? "cut";
  if (mode === "cut" || scene.sceneNumber <= 1) return {};

  const previous = record.storyboard?.scenes.find(
    (s) => s.sceneNumber === scene.sceneNumber - 1,
  );
  if (!previous) return {};
  const attempt = chosenAttempt(record, previous.id);
  if (!attempt) return {};

  if (mode === "reuse_end_frame" && attempt.endImagePath) {
    return { startImagePath: attempt.endImagePath };
  }
  if (mode === "continue_video" && attempt.videoPath) {
    return { videoSource: attempt.videoPath };
  }
  return {};
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

  const continuity = resolveContinuity(record, scene);
  const continuing = Boolean(continuity.videoSource);

  const keyframe = async (
    purpose: "start_frame" | "end_frame",
    prompt: string,
  ): Promise<{ id: string; path?: string }> => {
    const manifest = await buildImageManifest({
      sceneId,
      purpose,
      prompt,
      negativePrompt: scene.prompts.imageNegativePrompt,
      modelStrategy,
      modelType: imageModel,
      imageRefs,
    });
    const job = await runToCompletion(manifest.settings);
    return { id: manifest.id, path: job.generatedFiles[0] };
  };

  // Continuing from the previous clip supersedes both keyframes; reusing the
  // previous end frame supersedes only the start frame. Anything skipped here
  // is an image render that never happens.
  const start =
    continuing || continuity.startImagePath
      ? null
      : await keyframe("start_frame", scene.prompts.startFramePrompt);
  const end = continuing ? null : await keyframe("end_frame", scene.prompts.endFramePrompt);

  const startImagePath = continuity.startImagePath ?? start?.path;
  const endImagePath = end?.path;

  const videoManifest = await buildVideoManifest({
    sceneId,
    prompt: scene.prompts.videoPromptSegment,
    negativePrompt: scene.prompts.videoNegativePrompt,
    imageStart: startImagePath,
    imageEnd: endImagePath,
    videoSource: continuity.videoSource,
    modelStrategy,
    modelType: videoModel,
    // The final scene is often shorter than a full segment.
    durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
  });
  const videoJob = await runToCompletion(videoManifest.settings);

  logEvent("scene.continuity", {
    projectId,
    sceneId,
    mode: record.project.sceneContinuity ?? "cut",
    reusedStartFrame: Boolean(continuity.startImagePath),
    continuedFromVideo: continuing,
    imageRendersSkipped: (continuing ? 2 : 0) + (continuity.startImagePath ? 1 : 0),
  });

  const existing = record.attempts?.[sceneId] ?? [];
  const attempt: SceneAttempt = {
    id: randomUUID(),
    sceneId,
    attemptNumber: existing.length + 1,
    startImagePath,
    endImagePath,
    videoPath: videoJob.generatedFiles[0],
    settingsIds: [start?.id, end?.id, videoManifest.id].filter(
      (id): id is string => id !== undefined,
    ),
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
