import { randomUUID } from "node:crypto";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildImageManifest, buildVideoManifest, runToCompletion } from "@/lib/services/wangp-service";
import { resolveSceneLoras } from "@/lib/services/lora-service";
import { faceSwapSubject, swapFace } from "@/lib/services/face-swap-service";
import { referenceImagesOf } from "@/lib/schemas/character";
import type { Character } from "@/lib/schemas/character";
import { DEFAULT_SCENE_CONTINUITY } from "@/lib/types";
import { resolveProjectCast } from "@/lib/services/character-service";
import { resolveReferenceImagePath } from "@/lib/db/character-store";
import { config } from "@/lib/config";
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
    .flatMap((character) => referenceImagesOf(character))
    .map((filename) => resolveReferenceImagePath(filename))
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
  const mode = record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY;
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
/**
 * Render one keyframe for a scene.
 *
 * Shared by full scene generation and the standalone preview so a preview shows
 * exactly what generation would produce — a preview rendered down a different
 * code path would be worth very little as a check.
 */
async function renderKeyframe(
  record: ProjectRecord,
  scene: Scene,
  purpose: "start_frame" | "end_frame",
  prompt: string,
  castRefs: string[],
  extraRefs: string[] = [],
  swapSubject: Character | null = null,
): Promise<{ id: string; path?: string }> {
  const manifest = await buildImageManifest({
    sceneId: scene.id,
    purpose,
    prompt,
    negativePrompt: scene.prompts.imageNegativePrompt,
    modelStrategy: record.project.modelStrategy,
    modelType: record.project.imageModel,
    imageRefs: [...extraRefs, ...castRefs],
    // A leading scene frame is the "main subject / landscape" reference; the
    // cast portraits that follow are the people.
    imageRefsLeadWithScene: extraRefs.length > 0,
    loras: resolveSceneLoras(record.project, scene.id, "image"),
  });
  const job = await runToCompletion(manifest.settings);
  const rendered = job.generatedFiles[0];

  // Swap before returning, so whatever consumes this frame — the end-frame
  // render, the clip, the next scene's inherited start — sees the corrected
  // face. Deferring it would mean those all carry the uncorrected one.
  if (rendered && swapSubject) {
    const swapped = await swapFace(rendered, swapSubject, { sceneId: scene.id, purpose });
    if (swapped) return { id: manifest.id, path: swapped };
  }

  return { id: manifest.id, path: rendered };
}

/**
 * Render a single keyframe without touching the scene's attempts.
 *
 * Tuning a prompt otherwise costs a whole scene — two images and a clip, minutes
 * of GPU time — to judge a change that is obvious from one still. The result is
 * stored as a preview rather than an attempt, because media listing and assembly
 * both take a scene's newest attempt and a partial one would mask a finished
 * clip. Previews are never approved and never assembled.
 */
export async function generateSceneKeyframe(
  projectId: string,
  sceneId: string,
  purpose: "start_frame" | "end_frame",
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");
  const scene = findScene(record, sceneId);

  const castRefs = await resolveCastReferenceImages(record);
  const swapSubject = faceSwapSubject(await resolveProjectCast(record.project));

  // The end frame is normally shown the start frame to match. Reuse whichever
  // start frame already exists so the preview is conditioned the same way the
  // real render would be; with none, it falls back to a plain text-to-image.
  let extraRefs: string[] = [];
  let prompt =
    purpose === "start_frame" ? scene.prompts.startFramePrompt : scene.prompts.endFramePrompt;

  if (purpose === "end_frame" && config.media.endFrameReferencesStartFrame) {
    const existingStart =
      record.previews?.[sceneId]?.startFramePath ?? chosenAttempt(record, sceneId)?.startImagePath;
    if (existingStart) {
      extraRefs = [existingStart];
      prompt = `${prompt} Wardrobe, hair, styling, location and lighting exactly as in the supplied reference frame; identical clothing.`;
    }
  }

  const result = await renderKeyframe(record, scene, purpose, prompt, castRefs, extraRefs, swapSubject);
  if (!result.path) throw new ValidationError(`WanGP returned no image for the ${purpose}.`);

  const previous = record.previews?.[sceneId];
  const updated: ProjectRecord = {
    ...record,
    previews: {
      ...(record.previews ?? {}),
      [sceneId]: {
        ...previous,
        ...(purpose === "start_frame"
          ? { startFramePath: result.path }
          : { endFramePath: result.path }),
        updatedAt: new Date().toISOString(),
      },
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      {
        at: new Date().toISOString(),
        action: "scene.keyframe_preview",
        detail: `Scene ${scene.sceneNumber} ${purpose.replace("_", " ")}`,
      },
    ],
  };

  await repository.update(projectId, updated);
  logEvent("scene.keyframe_preview", { projectId, sceneId, purpose });
  return updated;
}

/**
 * Whether a batch can use the phased path.
 *
 * Three conditions, all necessary:
 *
 *  - **More than one scene.** Phasing trades immediacy for fewer model loads,
 *    and with one scene there are no loads to save.
 *  - **Face swap active.** Without it a scene needs only the image and video
 *    models, so scene-at-a-time already costs two loads per scene and phasing
 *    would save little while changing how progress appears.
 *  - **Not `continue_video`.** That mode continues each clip from the previous
 *    scene's *rendered clip*, so video generation cannot be deferred to a
 *    final phase without breaking the chain it depends on.
 */
export async function canRunPhased(record: ProjectRecord, sceneIds: string[]): Promise<boolean> {
  if (sceneIds.length < 2) return false;
  if ((record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) === "continue_video") return false;
  return faceSwapSubject(await resolveProjectCast(record.project)) !== null;
}

export type PhaseName = "keyframes" | "face_swap" | "video";

/**
 * Generate a whole batch in three model-ordered phases.
 *
 * WanGP holds one model at a time, and loading one takes upwards of a minute on
 * a single card. Generating scene-by-scene means image → swap → video → image →
 * swap → video, so a ten-scene run pays thirty model loads to do thirty jobs.
 * Grouping by model instead pays three, which turns roughly half an hour of
 * loading into three minutes.
 *
 * The cost is that a scene is no longer finished in one pass. Frames are
 * persisted as previews the moment each phase touches them, so the storyboard
 * still fills in continuously — keyframes appear during phases one and two,
 * clips one at a time during phase three — rather than going quiet.
 *
 * Only used for multi-scene batches; single-scene generation stays sequential,
 * where a phase split would save nothing and cost immediacy.
 */
export async function generateProjectMediaPhased(
  projectId: string,
  sceneIds: string[],
  hooks: {
    onPhase?: (phase: PhaseName) => void;
    onSceneComplete?: (sceneId: string) => void;
    shouldCancel?: () => boolean;
    /**
     * Wraps each WanGP job so the caller's retry policy still applies.
     *
     * Transient CUDA and out-of-memory faults are exactly what heavy model
     * swapping provokes, and without this a single blip would abandon the whole
     * batch — strictly worse than the scene-at-a-time path it replaces.
     */
    runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<void> {
  const run = hooks.runStep ?? (<T>(step: () => Promise<T>) => step());
  let record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");

  const scenes = record.storyboard.scenes
    .filter((scene) => sceneIds.includes(scene.id))
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  if (!scenes.length) return;

  const mode = record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY;
  const castRefs = await resolveCastReferenceImages(record);
  const swapSubject = faceSwapSubject(await resolveProjectCast(record.project));

  /** Rendered frame paths per scene, rewritten in place as phases progress. */
  const frames = new Map<string, { start?: string; end?: string; startId?: string; endId?: string }>();

  const persistPreview = async (sceneId: string, start?: string, end?: string) => {
    record = {
      ...record,
      previews: {
        ...(record.previews ?? {}),
        [sceneId]: {
          ...(record.previews?.[sceneId] ?? {}),
          ...(start ? { startFramePath: start } : {}),
          ...(end ? { endFramePath: end } : {}),
          updatedAt: new Date().toISOString(),
        },
      },
    };
    await repository.update(projectId, record);
  };

  // ---- Phase 1: every keyframe, on the image model -------------------------
  hooks.onPhase?.("keyframes");
  let previousEnd: string | undefined;

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;

    // Reusing the previous end frame is what makes a seam match exactly; it also
    // means most scenes render one keyframe rather than two.
    const inherited = mode === "reuse_end_frame" ? previousEnd : undefined;
    let startPath = inherited;
    let startId: string | undefined;

    if (!startPath) {
      const rendered = await run(() =>
        renderKeyframe(record, scene, "start_frame", scene.prompts.startFramePrompt, castRefs, [], null),
      );
      startPath = rendered.path;
      startId = rendered.id;
    }

    const conditionOnStart = config.media.endFrameReferencesStartFrame && Boolean(startPath);
    const matchInstruction = inherited
      ? " The character's wardrobe, hair and styling are exactly as in the supplied reference frame; identical clothing. Follow this scene's own description for location, framing and action."
      : " Wardrobe, hair, styling, location and lighting exactly as in the supplied reference frame; identical clothing.";

    const endRender = await run(() =>
      renderKeyframe(
        record,
        scene,
        "end_frame",
        conditionOnStart ? `${scene.prompts.endFramePrompt}${matchInstruction}` : scene.prompts.endFramePrompt,
        castRefs,
        conditionOnStart ? [startPath!] : [],
        null,
      ),
    );

    frames.set(scene.id, { start: startPath, end: endRender.path, startId, endId: endRender.id });
    previousEnd = endRender.path;
    await persistPreview(scene.id, startPath, endRender.path);
  }

  // ---- Phase 2: swap every distinct frame, on the edit model ---------------
  if (swapSubject) {
    hooks.onPhase?.("face_swap");

    // Under reuse_end_frame one file is both a scene's end frame and the next
    // scene's start frame. Swapping per scene would run it twice, wasting a
    // render and producing two subtly different images for the same moment.
    const distinct = new Set<string>();
    for (const entry of frames.values()) {
      if (entry.start) distinct.add(entry.start);
      if (entry.end) distinct.add(entry.end);
    }

    const swapped = new Map<string, string>();
    for (const original of distinct) {
      if (hooks.shouldCancel?.()) return;
      const result = await swapFace(original, swapSubject, { sceneId: "batch", purpose: "keyframe" });
      swapped.set(original, result ?? original);
    }

    for (const [sceneId, entry] of frames) {
      const start = entry.start ? swapped.get(entry.start) : undefined;
      const end = entry.end ? swapped.get(entry.end) : undefined;
      frames.set(sceneId, { ...entry, start, end });
      await persistPreview(sceneId, start, end);
    }
  }

  // ---- Phase 3: every clip, on the video model -----------------------------
  hooks.onPhase?.("video");

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;
    const entry = frames.get(scene.id);
    if (!entry) continue;

    const videoManifest = await buildVideoManifest({
      sceneId: scene.id,
      prompt: scene.prompts.videoPromptSegment,
      negativePrompt: scene.prompts.videoNegativePrompt,
      imageStart: entry.start,
      imageEnd: entry.end,
      modelStrategy: record.project.modelStrategy,
      modelType: record.project.videoModel,
      loras: resolveSceneLoras(record.project, scene.id, "video"),
      durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
    });
    const videoJob = await run(() => runToCompletion(videoManifest.settings));

    record = await getProjectRecord(projectId);
    const existing = record.attempts?.[scene.id] ?? [];
    const attempt: SceneAttempt = {
      id: randomUUID(),
      sceneId: scene.id,
      attemptNumber: existing.length + 1,
      startImagePath: entry.start,
      endImagePath: entry.end,
      videoPath: videoJob.generatedFiles[0],
      settingsIds: [entry.startId, entry.endId, videoManifest.id].filter(
        (id): id is string => id !== undefined,
      ),
      approved: false,
      createdAt: new Date().toISOString(),
    };
    attempt.qcResult = await qcAgent(scene, attempt, getPlanningProvider());

    const nextStatus: Scene["status"] = attempt.qcResult.passed ? "generated" : "needs_review";
    let updated = withSceneStatus(record, scene.id, nextStatus);
    updated = {
      ...updated,
      attempts: { ...(updated.attempts ?? {}), [scene.id]: [...existing, attempt] },
      project: { ...updated.project, status: "generating", updatedAt: new Date().toISOString() },
      history: [
        ...(updated.history ?? []),
        {
          at: new Date().toISOString(),
          action: "scene.generated",
          detail: `${scene.id} #${attempt.attemptNumber}`,
        },
      ],
    };
    await repository.update(projectId, updated);
    record = updated;

    logEvent("scene.qc", { projectId, sceneId: scene.id, passed: attempt.qcResult.passed });
    hooks.onSceneComplete?.(scene.id);
  }
}

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
  // One subject per scene: the preset's prompt names "the woman", so a second
  // opted-in character has no unambiguous place to go.
  const swapSubject = faceSwapSubject(await resolveProjectCast(record.project));

  const continuity = resolveContinuity(record, scene);
  const continuing = Boolean(continuity.videoSource);

  // A scene either inherits the storyboard-wide selection or replaces it. The
  // manifest builders reconcile these against whichever model they resolve, so
  // a substitution cannot smuggle an incompatible LoRA into the job.
  const imageLoras = resolveSceneLoras(record.project, sceneId, "image");
  const videoLoras = resolveSceneLoras(record.project, sceneId, "video");

  const keyframe = async (
    purpose: "start_frame" | "end_frame",
    prompt: string,
    extraRefs: string[] = [],
  ): Promise<{ id: string; path?: string }> =>
    renderKeyframe(record, scene, purpose, prompt, imageRefs, extraRefs, swapSubject);

  // Continuing from the previous clip supersedes both keyframes; reusing the
  // previous end frame supersedes only the start frame. Anything skipped here
  // is an image render that never happens.
  const start =
    continuing || continuity.startImagePath
      ? null
      : await keyframe("start_frame", scene.prompts.startFramePrompt);

  const startImagePath = continuity.startImagePath ?? start?.path;

  /**
   * Show the end-frame render the image it has to match.
   *
   * The two frames are otherwise independent text-to-image jobs, so anything
   * the prompt leaves unstated is reinvented — which is how a character ends up
   * in black trousers in one frame and blue jeans in the next.
   *
   * What the reference is allowed to dictate depends on where it came from:
   *
   *  - This scene's own start frame is the same moment seconds earlier, so the
   *    set and lighting must match as well as the wardrobe.
   *  - An inherited frame (reuse_end_frame continuity) is the *previous*
   *    scene's ending. Character and wardrobe still have to carry, but the
   *    scene is entitled to move — pinning the location here would stop the
   *    story progressing and fight the scene's own prompt.
   */
  const inheritedStart = Boolean(continuity.startImagePath);
  const conditionOnStartFrame = config.media.endFrameReferencesStartFrame && Boolean(startImagePath);
  const matchInstruction = inheritedStart
    ? " The character's wardrobe, hair and styling are exactly as in the supplied reference frame; identical clothing. Follow this scene's own description for location, framing and action."
    : " Wardrobe, hair, styling, location and lighting exactly as in the supplied reference frame; identical clothing.";

  const end = continuing
    ? null
    : await keyframe(
        "end_frame",
        conditionOnStartFrame
          ? `${scene.prompts.endFramePrompt}${matchInstruction}`
          : scene.prompts.endFramePrompt,
        conditionOnStartFrame ? [startImagePath!] : [],
      );

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
    loras: videoLoras,
    // The final scene is often shorter than a full segment.
    durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
  });
  const videoJob = await runToCompletion(videoManifest.settings);

  logEvent("scene.continuity", {
    projectId,
    sceneId,
    mode: record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY,
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
