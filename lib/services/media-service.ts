import { randomInt, randomUUID } from "node:crypto";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildImageManifest, buildVideoManifest, runToCompletion } from "@/lib/services/wangp-service";
import type { FrameOptions } from "@/lib/services/wangp-service";
import { resolveSceneLoras } from "@/lib/services/lora-service";
import { faceSwapSubject, swapFace } from "@/lib/services/face-swap-service";
import { referenceImagesOf } from "@/lib/schemas/character";
import type { Character } from "@/lib/schemas/character";
import { seamBreak } from "@/lib/media/seam";
import { DEFAULT_SCENE_CONTINUITY, generationStages } from "@/lib/types";
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

/** The stages this project's generation mode allows. */
function stagesOf(record: ProjectRecord) {
  return generationStages(record.project.generationMode);
}

/** Frame shape and quality, which together decide the render resolution. */
function frameOf(project: ProjectRecord["project"]): FrameOptions {
  return { aspectRatio: project.aspectRatio, resolutionPreset: project.resolutionPreset };
}

/** Refuse rather than silently render past what the project asked for. */
function requireKeyframeStage(record: ProjectRecord): void {
  if (stagesOf(record).keyframes) return;
  throw new ValidationError(
    "This project's generation mode is Storyboard only, so no media is rendered. " +
      "Change it on the Storyboard screen to render keyframes or clips.",
  );
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

/**
 * Pin an image seed per scene, minting one on first use.
 *
 * Without this a preview and the keyframe it is meant to predict are two
 * independent samples, so liking a preview told you nothing about what the
 * scene would render. Re-rolling is deliberate rather than incidental — see
 * `clearSceneSeed`.
 */
async function ensureSceneSeeds(
  projectId: string,
  record: ProjectRecord,
  sceneIds: readonly string[],
): Promise<ProjectRecord> {
  const seeds = { ...(record.project.sceneSeeds ?? {}) };
  let minted = false;
  for (const sceneId of sceneIds) {
    if (seeds[sceneId] === undefined) {
      seeds[sceneId] = randomInt(0, 2 ** 31 - 1);
      minted = true;
    }
  }
  if (!minted) return record;

  const updated: ProjectRecord = {
    ...record,
    project: { ...record.project, sceneSeeds: seeds, updatedAt: new Date().toISOString() },
  };
  await repository.update(projectId, updated);
  return updated;
}

/**
 * The seed one keyframe of a scene renders at, derived from the scene's pin.
 *
 * The two frames share a prompt skeleton and the end frame is additionally
 * conditioned on the start image, so sampling both from the same number
 * produced two copies of the same picture — and under `reuse_end_frame` that
 * copy then propagated into the next scene. Offsetting the end frame keeps the
 * pin meaningful (a preview still predicts the keyframe it stands in for) while
 * letting the pair differ.
 */
function keyframeSeed(
  base: number | undefined,
  purpose: "start_frame" | "end_frame",
): number | undefined {
  if (base === undefined) return undefined;
  return purpose === "start_frame" ? base : (base + 1) % (2 ** 31 - 1);
}

/** Drop a scene's pinned seed so the next render samples afresh. */
export async function clearSceneSeed(projectId: string, sceneId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  if (record.project.sceneSeeds?.[sceneId] === undefined) return record;

  const seeds = { ...record.project.sceneSeeds };
  delete seeds[sceneId];

  const updated: ProjectRecord = {
    ...record,
    project: { ...record.project, sceneSeeds: seeds, updatedAt: new Date().toISOString() },
  };
  await repository.update(projectId, updated);
  logEvent("scene.seed_cleared", { projectId, sceneId });
  return updated;
}

/** The attempt a scene is currently represented by: approved first, else latest. */function chosenAttempt(record: ProjectRecord, sceneId: string): SceneAttempt | undefined {
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
    const broken = seamBreak(previous, scene);
    if (broken) {
      logEvent("scene.continuity", {
        projectId: record.project.id,
        sceneId: scene.id,
        mode,
        reusedStartFrame: false,
        seamBreak: broken.reason,
        detail: broken.detail,
      });
      return {};
    }
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
): Promise<{ id: string; path?: string; source?: string }> {
  const manifest = await buildImageManifest({
    sceneId: scene.id,
    purpose,
    prompt,
    negativePrompt: scene.prompts.imageNegativePrompt,
    modelStrategy: record.project.modelStrategy,
    modelType: record.project.imageModel,
    seed: keyframeSeed(record.project.sceneSeeds?.[scene.id], purpose),
    steps: record.project.imageSteps,
    frame: frameOf(record.project),
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
    // The swap prompt is unconditional: told to replace "the head of the woman"
    // in a frame that has none, the model invents somewhere to put one.
    if (scene.subjectFaceVisible === false) {
      logEvent("face_swap.skipped", { reason: "no_face_in_shot", sceneId: scene.id, purpose });
      return { id: manifest.id, path: rendered };
    }
    const swapped = await swapFace(rendered, swapSubject, { sceneId: scene.id, purpose });
    if (swapped) return { id: manifest.id, path: swapped, source: rendered };
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
  requireKeyframeStage(record);
  const scene = findScene(record, sceneId);

  const seeded = await ensureSceneSeeds(projectId, record, [sceneId]);
  const castRefs = await resolveCastReferenceImages(seeded);
  const swapSubject = faceSwapSubject(await resolveProjectCast(seeded.project));

  // The end frame is normally shown the start frame to match. Reuse whichever
  // start frame already exists so the preview is conditioned the same way the
  // real render would be; with none, it falls back to a plain text-to-image.
  let extraRefs: string[] = [];
  let prompt =
    purpose === "start_frame" ? scene.prompts.startFramePrompt : scene.prompts.endFramePrompt;

  if (purpose === "end_frame" && config.media.endFrameReferencesStartFrame) {
    const existingStart =
      seeded.previews?.[sceneId]?.startFramePath ?? chosenAttempt(seeded, sceneId)?.startImagePath;
    if (existingStart) {
      extraRefs = [existingStart];
      prompt = `${prompt} Wardrobe, hair, styling, location and lighting exactly as in the supplied reference frame; identical clothing.`;
    }
  }

  const result = await renderKeyframe(seeded, scene, purpose, prompt, castRefs, extraRefs, swapSubject);
  if (!result.path) throw new ValidationError(`WanGP returned no image for the ${purpose}.`);

  const previous = seeded.previews?.[sceneId];
  const updated: ProjectRecord = {
    ...seeded,
    previews: {
      ...(seeded.previews ?? {}),
      [sceneId]: {
        ...previous,
        ...(purpose === "start_frame"
          ? { startFramePath: result.path }
          : { endFramePath: result.path }),
        updatedAt: new Date().toISOString(),
      },
    },
    project: { ...seeded.project, updatedAt: new Date().toISOString() },
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
 * Drop a scene's keyframe previews.
 *
 * Only the record entry is cleared. The rendered files stay in WanGP's output
 * directory, which StoryForge does not own and shares with the WanGP UI.
 */
export async function clearSceneKeyframePreview(
  projectId: string,
  sceneId: string,
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  if (!record.previews?.[sceneId]) return record;

  const previews = { ...record.previews };
  delete previews[sceneId];

  const updated: ProjectRecord = {
    ...record,
    previews,
    project: { ...record.project, updatedAt: new Date().toISOString() },
  };

  await repository.update(projectId, updated);
  logEvent("scene.keyframe_preview_cleared", { projectId, sceneId });
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

export type PhaseName = "keyframes" | "face_swap" | "video" | "qc";

/**
 * Generate a whole batch in model-ordered phases.
 *
 * WanGP holds one model at a time, and loading one takes upwards of a minute on
 * a single card. Generating scene-by-scene means image → swap → video → image →
 * swap → video, so a ten-scene run pays thirty model loads to do thirty jobs.
 * Grouping by model instead pays three, which turns roughly half an hour of
 * loading into three minutes.
 *
 * QC is the fourth phase for the same reason, not merely for tidiness: it is an
 * LLM round-trip, and on a single-GPU machine answering it pulls the planning
 * model back onto the card the batch deliberately cleared. Scoring between
 * clips is what starves the next video render of VRAM, so every scene is scored
 * once the GPU work is done.
 *
 * The cost is that a scene is no longer finished in one pass; it appears in the
 * storyboard when its clip lands during phase three. Intermediate keyframes are
 * held in memory rather than written to the record, because the only slot for a
 * frame without a clip is the preview map — and a preview is something the user
 * asks for, not a side effect of pressing "generate".
 *
 * Only used for multi-scene batches; single-scene generation stays sequential,
 * where a phase split would save nothing and cost immediacy.
 */
export async function generateProjectMediaPhased(
  projectId: string,
  sceneIds: string[],
  hooks: {
    /**
     * A phase is starting. `total` is the number of units it will work through
     * — scenes for the render phases, distinct frames for the swap — so a batch
     * that spends an hour inside one phase can still show movement.
     */
    onPhase?: (phase: PhaseName, total: number) => void;
    /** One unit of the current phase finished. */
    onPhaseProgress?: (completed: number) => void;
    onSceneComplete?: (sceneId: string) => void;
    /** A scene whose clip failed. The batch carries on with the rest. */
    onSceneFailed?: (sceneId: string, error: string) => void;
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
  requireKeyframeStage(record);
  const stages = stagesOf(record);

  const scenes = record.storyboard.scenes
    .filter((scene) => sceneIds.includes(scene.id))
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  if (!scenes.length) return;

  const mode = record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY;
  record = await ensureSceneSeeds(projectId, record, scenes.map((scene) => scene.id));
  const castRefs = await resolveCastReferenceImages(record);
  const swapSubject = faceSwapSubject(await resolveProjectCast(record.project));

  /** Rendered frame paths per scene, rewritten in place as phases progress. */
  const frames = new Map<
    string,
    {
      start?: string;
      end?: string;
      startId?: string;
      endId?: string;
      attemptId?: string;
      /** Start frame came from the previous scene, so this scene's prompt was not rendered. */
      inherited?: boolean;
      /** Pre-swap renders, set when phase 2 replaces a frame. */
      startSource?: string;
      endSource?: string;
    }
  >();

  // ---- Phase 1: every keyframe, on the image model -------------------------
  hooks.onPhase?.("keyframes", scenes.length);
  let previousEnd: string | undefined;
  let previousScene: Scene | undefined;
  let done = 0;

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;

    try {
      // Reusing the previous end frame is what makes a seam match exactly; it also
      // means most scenes render one keyframe rather than two. It is only correct
      // where the action is continuous — across a planned cut it would discard
      // this scene's start-frame prompt and freeze the old framing.
      const broken = previousScene && previousEnd ? seamBreak(previousScene, scene) : null;
      if (broken) {
        logEvent("scene.continuity", {
          projectId: record.project.id,
          sceneId: scene.id,
          mode,
          reusedStartFrame: false,
          seamBreak: broken.reason,
          detail: broken.detail,
        });
      }
      const inherited = mode === "reuse_end_frame" && !broken ? previousEnd : undefined;
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

      frames.set(scene.id, {
        start: startPath,
        end: endRender.path,
        startId,
        endId: endRender.id,
        inherited: Boolean(inherited),
      });
      previousEnd = endRender.path;
      previousScene = scene;
    } catch (err) {
      // Same reasoning as the clip phase: one scene must not cost the rest. The
      // chain resets so the next scene renders its own start frame rather than
      // inheriting a frame that was never produced.
      previousEnd = undefined;
      previousScene = undefined;
      hooks.onSceneFailed?.(
        scene.id,
        err instanceof Error ? err.message : "Keyframe generation failed",
      );
    }
    hooks.onPhaseProgress?.((done += 1));
  }

  // ---- Phase 2: swap every distinct frame, on the edit model ---------------
  if (swapSubject) {
    // Under reuse_end_frame one file is both a scene's end frame and the next
    // scene's start frame. Swapping per scene would run it twice, wasting a
    // render and producing two subtly different images for the same moment.
    //
    // A frame is swapped when any scene using it shows the face: a shared frame
    // that a face scene depends on still needs correcting.
    const distinct = new Set<string>();
    for (const [sceneId, entry] of frames) {
      if (scenes.find((s) => s.id === sceneId)?.subjectFaceVisible === false) continue;
      if (entry.start) distinct.add(entry.start);
      if (entry.end) distinct.add(entry.end);
    }

    hooks.onPhase?.("face_swap", distinct.size);
    const swapped = new Map<string, string>();
    let swappedCount = 0;
    for (const original of distinct) {
      if (hooks.shouldCancel?.()) return;
      const result = await swapFace(original, swapSubject, { sceneId: "batch", purpose: "keyframe" });
      swapped.set(original, result ?? original);
      hooks.onPhaseProgress?.((swappedCount += 1));
    }

    for (const [sceneId, entry] of frames) {
      // A frame left out of the swap set keeps its original path.
      const start = entry.start ? (swapped.get(entry.start) ?? entry.start) : undefined;
      const end = entry.end ? (swapped.get(entry.end) ?? entry.end) : undefined;
      frames.set(sceneId, {
        ...entry,
        start,
        end,
        startSource: start !== entry.start ? entry.start : undefined,
        endSource: end !== entry.end ? entry.end : undefined,
      });
    }
  }

  // Bank the frames before any video work starts.
  //
  // Phase 1 is hours of GPU time on a full storyboard, and until this point it
  // lived only in the `frames` map — a dropped connection during phase 3 threw
  // every rendered keyframe away. Writing them as attempts now means a batch
  // that dies later leaves its images attached to their scenes, and phase 3
  // completes those attempts in place rather than opening new ones.
  for (const [sceneId, entry] of frames) {
    if (hooks.shouldCancel?.()) return;
    if (!entry.start && !entry.end) continue;
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) continue;

    record = await getProjectRecord(projectId);
    const existing = record.attempts?.[sceneId] ?? [];
    const attempt: SceneAttempt = {
      id: randomUUID(),
      sceneId,
      attemptNumber: existing.length + 1,
      startImagePath: entry.start,
      endImagePath: entry.end,
      startImageSourcePath: entry.startSource,
      endImageSourcePath: entry.endSource,
      startImageInherited: entry.inherited || undefined,
      settingsIds: [entry.startId, entry.endId].filter((id): id is string => id !== undefined),
      approved: false,
      createdAt: new Date().toISOString(),
    };
    record = await persistAttempt(projectId, scene, attempt, existing, record);
    frames.set(sceneId, { ...entry, attemptId: attempt.id });
  }

  // ---- Phase 3: every clip, on the video model -----------------------------
  hooks.onPhase?.("video", scenes.length);
  const scored: { scene: Scene; attempt: SceneAttempt }[] = [];
  let clips = 0;

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;
    const entry = frames.get(scene.id);
    if (!entry) continue;

    try {
      // `keyframes_only` stops here: the attempt is the two frames, and no video
      // model is ever loaded.
      const videoManifest = stages.video
        ? await buildVideoManifest({
            sceneId: scene.id,
            prompt: scene.prompts.videoPromptSegment,
            negativePrompt: scene.prompts.videoNegativePrompt,
            imageStart: entry.start,
            imageEnd: entry.end,
            modelStrategy: record.project.modelStrategy,
            modelType: record.project.videoModel,
            steps: record.project.videoSteps,
            frame: frameOf(record.project),
            loras: resolveSceneLoras(record.project, scene.id, "video"),
            durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
          })
        : undefined;
      const videoJob = videoManifest
        ? await run(() => runToCompletion(videoManifest.settings))
        : undefined;

      record = await getProjectRecord(projectId);
      const attempt = await completeAttempt(projectId, scene, record, {
        attemptId: entry.attemptId,
        videoPath: videoJob?.generatedFiles[0],
        videoSettingsId: videoManifest?.id,
        frames: entry,
      });
      record = await getProjectRecord(projectId);
      scored.push({ scene, attempt });
      hooks.onSceneComplete?.(scene.id);
    } catch (err) {
      // One clip failing must not cost the scenes behind it. Their keyframes are
      // already rendered and their models already loaded, so abandoning the rest
      // of the batch throws away far more work than it saves.
      const message = err instanceof Error ? err.message : "Video generation failed";
      hooks.onSceneFailed?.(scene.id, message);
    }
    hooks.onPhaseProgress?.((clips += 1));
  }

  // ---- Phase 4: score every finished scene, on the planning model ----------
  // QC is a full LLM round-trip per scene on the GPU that just rendered them,
  // so it is opt-in. Without it the scenes still have to be closed out, or they
  // sit in their pre-QC status forever.
  if (scored.length) {
    if (!record.project.qcEnabled) {
      for (const { scene } of scored) await markGenerated(projectId, scene.id);
      return;
    }
    hooks.onPhase?.("qc", scored.length);
    let judged = 0;
    for (const { scene, attempt } of scored) {
      await scoreAttempt(projectId, scene, attempt, stages.video);
      hooks.onPhaseProgress?.((judged += 1));
    }
  }
}

/**
 * Attach a clip to the keyframe-only attempt phase 1 banked, or open a new one.
 *
 * Updating in place matters for more than tidiness: the banked attempt is what
 * the storyboard already shows for that scene, and appending a second one would
 * leave the frames-only entry sitting in the history as if it were a discarded
 * take.
 */
async function completeAttempt(
  projectId: string,
  scene: Scene,
  record: ProjectRecord,
  args: {
    attemptId?: string;
    videoPath?: string;
    videoSettingsId?: string;
    frames: { start?: string; end?: string; startId?: string; endId?: string };
  },
): Promise<SceneAttempt> {
  const existing = record.attempts?.[scene.id] ?? [];
  const banked = args.attemptId ? existing.find((a) => a.id === args.attemptId) : undefined;

  if (banked) {
    const completed: SceneAttempt = {
      ...banked,
      videoPath: args.videoPath,
      settingsIds: [...banked.settingsIds, args.videoSettingsId].filter(
        (id): id is string => id !== undefined,
      ),
    };
    const updated: ProjectRecord = {
      ...record,
      attempts: {
        ...(record.attempts ?? {}),
        [scene.id]: existing.map((a) => (a.id === banked.id ? completed : a)),
      },
      project: { ...record.project, status: "generating", updatedAt: new Date().toISOString() },
    };
    await repository.update(projectId, updated);
    return completed;
  }

  const attempt: SceneAttempt = {
    id: randomUUID(),
    sceneId: scene.id,
    attemptNumber: existing.length + 1,
    startImagePath: args.frames.start,
    endImagePath: args.frames.end,
    videoPath: args.videoPath,
    settingsIds: [args.frames.startId, args.frames.endId, args.videoSettingsId].filter(
      (id): id is string => id !== undefined,
    ),
    approved: false,
    createdAt: new Date().toISOString(),
  };
  await persistAttempt(projectId, scene, attempt, existing, record);
  return attempt;
}

/**
 * Store the finished attempt, then score it.
 *
 * QC is an LLM round-trip against the planning provider, and on a local model
 * that is minutes. Scoring first held a scene out of the storyboard for the
 * whole of it, long after WanGP had written the clip to disk. The attempt is
 * therefore persisted the moment the media exists, and the QC verdict lands as
 * a second write — the scene's status stays put until it does.
 *
 * The two halves are separable because a batch run needs them apart: see the
 * QC phase in `generateProjectMediaPhased`.
 */
async function persistThenScore(
  projectId: string,
  scene: Scene,
  attempt: SceneAttempt,
  existing: SceneAttempt[],
  record: ProjectRecord,
  expectVideo: boolean,
): Promise<ProjectRecord> {
  await persistAttempt(projectId, scene, attempt, existing, record);
  if (!record.project.qcEnabled) return markGenerated(projectId, scene.id);
  return scoreAttempt(projectId, scene, attempt, expectVideo);
}

/** Close a scene out without a QC verdict, for projects that grade manually. */
async function markGenerated(projectId: string, sceneId: string): Promise<ProjectRecord> {
  const latest = await getProjectRecord(projectId);
  const updated = withSceneStatus(latest, sceneId, "generated");
  await repository.update(projectId, updated);
  return updated;
}

/** Write the attempt and its media into the record, unscored. */
async function persistAttempt(
  projectId: string,
  scene: Scene,
  attempt: SceneAttempt,
  existing: SceneAttempt[],
  record: ProjectRecord,
): Promise<ProjectRecord> {
  const staged: ProjectRecord = {
    ...record,
    attempts: { ...(record.attempts ?? {}), [scene.id]: [...existing, attempt] },
    project: { ...record.project, status: "generating", updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      {
        at: new Date().toISOString(),
        action: "scene.generated",
        detail: `${scene.id} #${attempt.attemptNumber}`,
      },
    ],
  };
  await repository.update(projectId, staged);
  return staged;
}

/** Run QC over an already-persisted attempt and record the verdict. */
async function scoreAttempt(
  projectId: string,
  scene: Scene,
  attempt: SceneAttempt,
  expectVideo: boolean,
): Promise<ProjectRecord> {
  const qcResult = await qcAgent(scene, attempt, getPlanningProvider(), { expectVideo });

  // Re-read: the QC call is long enough for the record to have moved on.
  const latest = await getProjectRecord(projectId);
  let updated = withSceneStatus(latest, scene.id, qcResult.passed ? "generated" : "needs_review");
  updated = {
    ...updated,
    attempts: {
      ...(updated.attempts ?? {}),
      [scene.id]: (updated.attempts?.[scene.id] ?? []).map((a) =>
        a.id === attempt.id ? { ...a, qcResult } : a,
      ),
    },
    project: { ...updated.project, updatedAt: new Date().toISOString() },
  };
  await repository.update(projectId, updated);

  logEvent("scene.qc", { projectId, sceneId: scene.id, passed: qcResult.passed });
  return updated;
}

export async function generateSceneMedia(projectId: string, sceneId: string): Promise<ProjectRecord> {
  const loaded = await getProjectRecord(projectId);
  if (!loaded.storyboard) throw new ValidationError("Generate a storyboard before media");
  requireKeyframeStage(loaded);
  const stages = stagesOf(loaded);
  const scene = findScene(loaded, sceneId);
  const record = await ensureSceneSeeds(projectId, loaded, [sceneId]);
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
  ): Promise<{ id: string; path?: string; source?: string }> =>
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

  // `keyframes_only` stops here: no video model is loaded and the attempt is
  // just the two frames.
  const videoManifest = stages.video
    ? await buildVideoManifest({
        sceneId,
        prompt: scene.prompts.videoPromptSegment,
        negativePrompt: scene.prompts.videoNegativePrompt,
        imageStart: startImagePath,
        imageEnd: endImagePath,
        videoSource: continuity.videoSource,
        modelStrategy,
        modelType: videoModel,
        steps: record.project.videoSteps,
        frame: frameOf(record.project),
        loras: videoLoras,
        // The final scene is often shorter than a full segment.
        durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
      })
    : undefined;
  const videoJob = videoManifest ? await runToCompletion(videoManifest.settings) : undefined;

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
    startImageSourcePath: start?.source,
    endImageSourcePath: end?.source,
    startImageInherited: continuity.startImagePath ? true : undefined,
    videoPath: videoJob?.generatedFiles[0],
    settingsIds: [start?.id, end?.id, videoManifest?.id].filter(
      (id): id is string => id !== undefined,
    ),
    approved: false,
    createdAt: new Date().toISOString(),
  };

  return persistThenScore(projectId, scene, attempt, existing, record, stages.video);
}

/**
 * Apply the face swap to one already-rendered keyframe.
 *
 * The automatic pass runs inline because each frame feeds the next — the end
 * frame is conditioned on the start frame, the next scene inherits the end
 * frame, and the clip is built from both. That ordering is why the swap cannot
 * simply be deferred to the end.
 *
 * This is the repair for when the plan and the render disagree: a shot the
 * Storyboard Agent called faceless that came back with a face in it. It edits
 * the stored frame in place and leaves everything downstream alone, so the
 * caller is responsible for re-rendering whatever already consumed it.
 */
export async function swapAttemptFrame(
  projectId: string,
  sceneId: string,
  purpose: "start_frame" | "end_frame",
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const scene = findScene(record, sceneId);
  const attempts = record.attempts?.[sceneId] ?? [];
  const target = attempts.at(-1);
  if (!target) throw new ValidationError("Generate this scene's media before swapping a face.");

  const framePath = purpose === "start_frame" ? target.startImagePath : target.endImagePath;
  if (!framePath) {
    throw new ValidationError(`This attempt has no ${purpose.replace("_", " ")} to swap.`);
  }

  // Swap the render, not a previous swap's output. Feeding an already-swapped
  // frame back in stacks a second pass on the first rather than redoing it.
  const source =
    (purpose === "start_frame" ? target.startImageSourcePath : target.endImageSourcePath) ??
    framePath;

  const subject = faceSwapSubject(await resolveProjectCast(record.project));
  if (!subject) {
    throw new ValidationError(
      "Face swap needs exactly one character in this project with face swap enabled and a " +
        "reference image.",
    );
  }

  const swapped = await swapFace(source, subject, { sceneId, purpose });
  if (!swapped) {
    throw new ValidationError(
      "The swap did not produce an image. Check that the Qwen Image Edit model and its " +
        "face-swap LoRAs are installed in WanGP.",
    );
  }

  const updated: ProjectRecord = {
    ...record,
    attempts: {
      ...(record.attempts ?? {}),
      [sceneId]: attempts.map((a) =>
        a.id === target.id
          ? {
              ...a,
              ...(purpose === "start_frame"
                ? { startImagePath: swapped, startImageSourcePath: source }
                : { endImagePath: swapped, endImageSourcePath: source }),
            }
          : a,
      ),
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      {
        at: new Date().toISOString(),
        action: "scene.face_swapped",
        detail: `Scene ${scene.sceneNumber} ${purpose.replace("_", " ")}`,
      },
    ],
  };

  await repository.update(projectId, updated);
  logEvent("face_swap.manual", { projectId, sceneId, purpose, character: subject.name });
  return updated;
}

/** Put back the frame as it was rendered, discarding the swap. */
export async function revertAttemptFrame(
  projectId: string,
  sceneId: string,
  purpose: "start_frame" | "end_frame",
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const scene = findScene(record, sceneId);
  const attempts = record.attempts?.[sceneId] ?? [];
  const target = attempts.at(-1);
  const source =
    purpose === "start_frame" ? target?.startImageSourcePath : target?.endImageSourcePath;
  if (!target || !source) {
    throw new ValidationError("This frame has no un-swapped original to go back to.");
  }

  const updated: ProjectRecord = {
    ...record,
    attempts: {
      ...(record.attempts ?? {}),
      [sceneId]: attempts.map((a) =>
        a.id === target.id
          ? {
              ...a,
              ...(purpose === "start_frame"
                ? { startImagePath: source, startImageSourcePath: undefined }
                : { endImagePath: source, endImageSourcePath: undefined }),
            }
          : a,
      ),
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      {
        at: new Date().toISOString(),
        action: "scene.face_swap_reverted",
        detail: `Scene ${scene.sceneNumber} ${purpose.replace("_", " ")}`,
      },
    ],
  };

  await repository.update(projectId, updated);
  logEvent("face_swap.reverted", { projectId, sceneId, purpose });
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
