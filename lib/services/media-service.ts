import { randomInt, randomUUID } from "node:crypto";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildImageManifest, buildVideoManifest, runToCompletion } from "@/lib/services/wangp-service";
import type { CastReference, FrameOptions } from "@/lib/services/wangp-service";
import { resolveSceneLoras } from "@/lib/services/lora-service";
import { faceSwapSubject, swapFace } from "@/lib/services/face-swap-service";
import { referenceImagesOf } from "@/lib/schemas/character";
import type { Character } from "@/lib/schemas/character";
import { seamBreak } from "@/lib/media/seam";
import { saveImportedFrame } from "@/lib/media/imported-frames";
import { DEFAULT_SCENE_CONTINUITY, generationStages } from "@/lib/types";
import { resolveProjectCast } from "@/lib/services/character-service";
import { charactersInScene } from "@/lib/agents/scene-cast";
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
function frameOf(project: ProjectRecord["project"], kind: "image" | "video" = "image"): FrameOptions {
  return {
    aspectRatio: project.aspectRatio,
    resolutionPreset:
      kind === "video"
        ? (project.videoResolutionPreset ?? project.resolutionPreset)
        : project.resolutionPreset,
  };
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
async function resolveCastReferenceImages(
  record: ProjectRecord,
  scene?: Scene,
): Promise<string[]> {
  // Off means off everywhere: the constraint that the image model must accept
  // references only applies while references are being sent, so opting out here
  // also frees the model choice.
  if (record.project.useCharacterReferenceImages === false) return [];
  const cast = await resolveProjectCast(record.project);
  // A reference photo outranks the prompt text, so one belonging to a character
  // who is not in this shot is the strongest possible instruction to put them
  // in it. Without a scene the whole cast applies, which is only right for
  // callers that have no single shot in hand.
  return referenceImagePathsOf(scene ? charactersInScene(scene, cast) : cast);
}

function referenceImagePathsOf(cast: readonly Character[]): string[] {
  return cast
    .flatMap((character) => referenceImagesOf(character))
    .map((filename) => resolveReferenceImagePath(filename))
    .filter((filePath): filePath is string => filePath !== null);
}

/**
 * The cast of one shot, each with the single photograph that fixes their face.
 *
 * One photograph per character, not all of them: on the reference variant every
 * image lengthens the same packed sequence at roughly seven minutes each, and a
 * second photo of the same person was measured as marginally better identity
 * for that whole cost. The written description travels alongside so the prompt
 * can name who each reference *is*, which is the only thing telling the model
 * that picture 3 is a person rather than another composition to reproduce.
 */
async function resolveCastSubjects(
  record: ProjectRecord,
  scene: Scene,
): Promise<CastReference[]> {
  if (record.project.useCharacterReferenceImages === false) return [];
  const cast = await resolveProjectCast(record.project);
  return charactersInScene(scene, cast)
    .map((character): CastReference | null => {
      const filename = referenceImagesOf(character)[0];
      const imagePath = filename ? resolveReferenceImagePath(filename) : null;
      return imagePath
        ? { name: character.name, description: character.description, imagePath }
        : null;
    })
    .filter((subject): subject is CastReference => subject !== null);
}

/** The face-swap target for one shot, or null when its subject is not in it. */
async function sceneFaceSwapSubject(record: ProjectRecord, scene: Scene) {
  const cast = await resolveProjectCast(record.project);
  return faceSwapSubject(charactersInScene(scene, cast));
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

/**
 * What the end frame's reference image is allowed to dictate.
 *
 * The reference is only ever a frame carried in from the previous scene. A
 * scene's own start frame is never shown to its end frame: an edit model handed
 * a picture returns that picture, so the two keyframes came back identical and
 * the clip between them had nothing to move through. Wording did not fix it —
 * only withholding the image did.
 *
 * The inherited frame is the previous scene's *ending*, so character and
 * wardrobe have to carry, but this scene is entitled to happen somewhere else.
 */
const MATCH_INSTRUCTION = {
  inherited:
    " The character's wardrobe, hair and styling are exactly as in the supplied reference frame; identical clothing." +
    " Follow this scene's own description for location, framing and action.",
  /** The one scene that depicts the costume change itself; its prompt names the outfit. */
  inheritedChangingWardrobe:
    " The character's hair and styling are exactly as in the supplied reference frame." +
    " Follow this scene's own description for location, framing, action and clothing.",
} as const;

/** Does this scene depict a costume change, rather than arriving with one done? */
function changingWardrobe(record: ProjectRecord, sceneId: string): boolean {
  return (record.project.wardrobeChanges?.[sceneId] ?? []).some((c) => c.mode === "within");
}

/**
 * Whether this scene's end frame is rendered with its start frame supplied as a
 * reference image.
 *
 * Only ever true for a *carried-over* start frame — see MATCH_INSTRUCTION for
 * why a scene is never shown the start frame it rendered itself. The per-scene
 * override can only turn it off: forcing it on where the scene rendered its own
 * start frame is the failure the exclusion exists to prevent.
 */
function referencesStartFrame(record: ProjectRecord, sceneId: string, inherited: boolean): boolean {
  if (!inherited || !config.media.endFrameReferencesStartFrame) return false;
  return record.project.sceneEndFrameRefs?.[sceneId] !== false;
}

/** Drop a scene's pinned seed so the next render samples afresh. */
export async function clearSceneSeed(projectId: string, sceneId: string): Promise<ProjectRecord> {  const record = await getProjectRecord(projectId);
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
  /**
   * What that reused frame shows — the *previous* scene's end-frame prompt.
   *
   * This scene's own start-frame prompt describes a picture that was never
   * rendered, so anything asking "what is in the opening frame" has to be told
   * this instead. Reference mode does exactly that, and a clip built from the
   * wrong answer opens on a shot nobody supplied.
   */
  startImagePrompt?: string;
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
    return { startImagePath: attempt.endImagePath, startImagePrompt: previous.prompts.endFramePrompt };
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
  const castRefs = await resolveCastReferenceImages(seeded, scene);
  const swapSubject = await sceneFaceSwapSubject(seeded, scene);

  // Condition the preview the same way the real render would be, so what it
  // predicts is what a full scene generation produces.
  let extraRefs: string[] = [];
  let prompt =
    purpose === "start_frame" ? scene.prompts.startFramePrompt : scene.prompts.endFramePrompt;

  if (purpose === "end_frame") {
    // Only a frame carried in from the previous scene. This scene's own start
    // frame is the picture the end frame is supposed to differ from.
    const inheritedStart = chosenAttempt(seeded, sceneId)?.startImageInherited
      ? chosenAttempt(seeded, sceneId)?.startImagePath
      : undefined;
    if (inheritedStart && referencesStartFrame(seeded, sceneId, true)) {
      extraRefs = [inheritedStart];
      prompt = changingWardrobe(seeded, sceneId)
        ? `${prompt}${MATCH_INSTRUCTION.inheritedChangingWardrobe}`
        : `${prompt}${MATCH_INSTRUCTION.inherited}`;
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
 * The cost is that a scene is no longer finished in one pass. Its keyframes are
 * banked as an attempt the moment phase one renders them, so the storyboard
 * fills in as frames land and a cancel keeps what was already paid for; the
 * swap and the clip then rewrite that same attempt in place.
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
    /**
     * Units of the current phase that have succeeded and failed. Counting an
     * attempt as progress made the number disagree with what reached the disk.
     */
    onPhaseProgress?: (completed: number, failed: number) => void;
    /** A scene began a phase. */
    onSceneEnterPhase?: (sceneId: string, phase: PhaseName) => void;
    /** A scene cleared a phase, and that phase's output is on the record. */
    onSceneClearPhase?: (sceneId: string, phase: PhaseName) => void;
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
  const projectCast = await resolveProjectCast(record.project);
  const useRefs = record.project.useCharacterReferenceImages !== false;
  const castRefsFor = (scene: Scene) =>
    useRefs ? referenceImagePathsOf(charactersInScene(scene, projectCast)) : [];
  const swapSubject = faceSwapSubject(projectCast);
  const inScene = (scene: Scene) =>
    !swapSubject || charactersInScene(scene, projectCast).some((c) => c.id === swapSubject.id);

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
      /** What the inherited frame shows: the previous scene's end-frame prompt. */
      inheritedPrompt?: string;
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
  let failedFrames = 0;

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;
    hooks.onSceneEnterPhase?.(scene.id, "keyframes");

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
          renderKeyframe(record, scene, "start_frame", scene.prompts.startFramePrompt, castRefsFor(scene), [], null),
        );
        startPath = rendered.path;
        startId = rendered.id;
      }

      const conditionOnStart = referencesStartFrame(record, scene.id, Boolean(inherited));
      const matchInstruction = changingWardrobe(record, scene.id)
        ? MATCH_INSTRUCTION.inheritedChangingWardrobe
        : MATCH_INSTRUCTION.inherited;

      const endRender = await run(() =>
        renderKeyframe(
          record,
          scene,
          "end_frame",
          conditionOnStart ? `${scene.prompts.endFramePrompt}${matchInstruction}` : scene.prompts.endFramePrompt,
          castRefsFor(scene),
          conditionOnStart ? [startPath!] : [],
          null,
        ),
      );

      const rendered = {
        start: startPath,
        end: endRender.path,
        startId,
        endId: endRender.id,
        inherited: Boolean(inherited),
        inheritedPrompt: inherited ? previousScene?.prompts.endFramePrompt : undefined,
      };

      // Banked here rather than after the swap phase. Until the attempt exists
      // the storyboard has nothing to show for hours of GPU time, and a cancel
      // discards it; phase 2 rewrites this same attempt with the swapped face.
      const attemptId = await bankKeyframes(projectId, scene, rendered);
      frames.set(scene.id, { ...rendered, attemptId });

      previousEnd = endRender.path;
      previousScene = scene;
      hooks.onPhaseProgress?.((done += 1), failedFrames);
      hooks.onSceneClearPhase?.(scene.id, "keyframes");
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
      hooks.onPhaseProgress?.(done, (failedFrames += 1));
    }
  }

  // ---- Phase 2: swap every distinct frame, on the edit model ---------------
  if (swapSubject) {
    // Under reuse_end_frame one file is both a scene's end frame and the next
    // scene's start frame. Swapping per scene would run it twice, wasting a
    // render and producing two subtly different images for the same moment.
    //
    // A shared frame is swapped only when *every* scene using it wants the
    // swap. The rule used to be "any", which let a scene that needed a face
    // pull its neighbour's frame into the swap set — and a shot of four men
    // that the plan called faceless came back with a woman's face grafted into
    // it. A missing correction is recoverable from the Swap face button; an
    // invented face in a frame nobody asked for is not.
    const wanted = new Set<string>();
    const refused = new Set<string>();
    for (const [sceneId, entry] of frames) {
      const scene = scenes.find((s) => s.id === sceneId);
      if (!scene) continue;
      // Swapping a face into a shot the subject is not in puts them in it.
      const allowed = scene.subjectFaceVisible !== false && inScene(scene);
      for (const path of [entry.start, entry.end]) {
        if (!path) continue;
        (allowed ? wanted : refused).add(path);
      }
    }

    const distinct = new Set([...wanted].filter((path) => !refused.has(path)));
    for (const path of wanted) {
      if (refused.has(path)) {
        logEvent("face_swap.skipped", { reason: "frame_shared_with_faceless_scene", path });
      }
    }

    hooks.onPhase?.("face_swap", distinct.size);

    // Which of a scene's frames are still waiting on the swap model. A scene
    // clears the phase when its last one lands, which under a continuous seam
    // can be a frame its neighbour was waiting on too.
    const outstanding = new Map<string, Set<string>>();
    for (const [sceneId, entry] of frames) {
      const mine = [entry.start, entry.end].filter(
        (path): path is string => path !== undefined && distinct.has(path),
      );
      outstanding.set(sceneId, new Set(mine));
      if (mine.length) hooks.onSceneEnterPhase?.(sceneId, "face_swap");
      else hooks.onSceneClearPhase?.(sceneId, "face_swap");
    }

    const swapped = new Map<string, string>();
    let swappedCount = 0;
    for (const original of distinct) {
      if (hooks.shouldCancel?.()) return;
      const result = await swapFace(original, swapSubject, { sceneId: "batch", purpose: "keyframe" });
      swapped.set(original, result ?? original);
      hooks.onPhaseProgress?.((swappedCount += 1), 0);

      // Rewrite a scene's banked attempt as soon as every frame of it is
      // corrected, so the storyboard shows the swapped face rather than the
      // render it replaced.
      for (const [sceneId, waiting] of outstanding) {
        if (!waiting.delete(original) || waiting.size) continue;
        const entry = frames.get(sceneId);
        if (!entry) continue;
        const next = withSwappedFrames(entry, swapped);
        frames.set(sceneId, next);
        if (next.attemptId) await rebankSwappedFrames(projectId, sceneId, next.attemptId, next);
        hooks.onSceneClearPhase?.(sceneId, "face_swap");
      }
    }
  }

  // ---- Phase 3: every clip, on the video model -----------------------------
  // Scenes whose keyframes failed are left out of the total: it states what this
  // phase can actually deliver, not how many scenes were asked for.
  hooks.onPhase?.("video", frames.size);
  const scored: { scene: Scene; attempt: SceneAttempt }[] = [];
  let clips = 0;
  let failedClips = 0;

  for (const scene of scenes) {
    if (hooks.shouldCancel?.()) return;
    const entry = frames.get(scene.id);
    if (!entry) continue;
    hooks.onSceneEnterPhase?.(scene.id, "video");

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
            frame: frameOf(record.project, "video"),
            loras: resolveSceneLoras(record.project, scene.id, "video"),
            durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
            soundscape: scene.prompts.videoSoundscape ?? scene.sfxNotes,
            score: scene.prompts.videoScore ?? scene.musicNotes,
            startFramePrompt: entry.inheritedPrompt ?? scene.prompts.startFramePrompt,
            endFramePrompt: scene.prompts.endFramePrompt,
            cast: await castFor(record, scene),
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
      hooks.onPhaseProgress?.((clips += 1), failedClips);
      hooks.onSceneClearPhase?.(scene.id, "video");
      hooks.onSceneComplete?.(scene.id);
    } catch (err) {
      // One clip failing must not cost the scenes behind it. Their keyframes are
      // already rendered and their models already loaded, so abandoning the rest
      // of the batch throws away far more work than it saves.
      const message = err instanceof Error ? err.message : "Video generation failed";
      hooks.onSceneFailed?.(scene.id, message);
      hooks.onPhaseProgress?.(clips, (failedClips += 1));
    }
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
      hooks.onSceneEnterPhase?.(scene.id, "qc");
      await scoreAttempt(projectId, scene, attempt, stages.video);
      hooks.onPhaseProgress?.((judged += 1), 0);
      hooks.onSceneClearPhase?.(scene.id, "qc");
    }
  }
}

/**
 * Write a scene's freshly rendered keyframes to the record as an attempt.
 *
 * Called the moment phase 1 clears a scene rather than at the end of the batch,
 * so the storyboard fills in while the run is still going and a cancel keeps
 * the frames already paid for.
 */
async function bankKeyframes(
  projectId: string,
  scene: Scene,
  frames: { start?: string; end?: string; startId?: string; endId?: string; inherited?: boolean },
): Promise<string> {
  const record = await getProjectRecord(projectId);
  const existing = record.attempts?.[scene.id] ?? [];
  const attempt: SceneAttempt = {
    id: randomUUID(),
    sceneId: scene.id,
    attemptNumber: existing.length + 1,
    startImagePath: frames.start,
    endImagePath: frames.end,
    startImageInherited: frames.inherited || undefined,
    settingsIds: [frames.startId, frames.endId].filter((id): id is string => id !== undefined),
    approved: false,
    createdAt: new Date().toISOString(),
  };
  await persistAttempt(projectId, scene, attempt, existing, record);
  return attempt.id;
}

/** A scene's frame paths after the swap phase, with the originals preserved. */
function withSwappedFrames<T extends { start?: string; end?: string }>(
  entry: T,
  swapped: Map<string, string>,
): T & { startSource?: string; endSource?: string } {
  // A frame left out of the swap set keeps its original path.
  const start = entry.start ? (swapped.get(entry.start) ?? entry.start) : undefined;
  const end = entry.end ? (swapped.get(entry.end) ?? entry.end) : undefined;
  return {
    ...entry,
    start,
    end,
    startSource: start !== entry.start ? entry.start : undefined,
    endSource: end !== entry.end ? entry.end : undefined,
  };
}

/**
 * Point a banked attempt at its swapped frames, keeping the pre-swap renders in
 * the `*SourcePath` fields.
 */
async function rebankSwappedFrames(
  projectId: string,
  sceneId: string,
  attemptId: string,
  frames: { start?: string; end?: string; startSource?: string; endSource?: string },
): Promise<void> {
  const record = await getProjectRecord(projectId);
  const attempts = record.attempts?.[sceneId] ?? [];
  if (!attempts.some((a) => a.id === attemptId)) return;

  const updated: ProjectRecord = {
    ...record,
    attempts: {
      ...(record.attempts ?? {}),
      [sceneId]: attempts.map((a) =>
        a.id === attemptId
          ? {
              ...a,
              startImagePath: frames.start,
              endImagePath: frames.end,
              startImageSourcePath: frames.startSource,
              endImageSourcePath: frames.endSource,
            }
          : a,
      ),
    },
    project: { ...record.project, updatedAt: new Date().toISOString() },
  };
  await repository.update(projectId, updated);
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

/**
 * Re-render one scene's clip from the keyframes it already has.
 *
 * Tweaking a video prompt or a motion LoRA does not change the frames, but a
 * full regeneration re-renders both of them anyway — two image jobs per scene,
 * discarded, to arrive back where you started. This keeps the frames and pays
 * only for the clip.
 *
 * The frames are taken from the chosen attempt rather than re-derived, so a
 * face swap or a hand-swapped frame is what the new clip is built on.
 */
export async function regenerateSceneVideo(
  projectId: string,
  sceneId: string,
): Promise<ProjectRecord> {
  const loaded = await getProjectRecord(projectId);
  if (!loaded.storyboard) throw new ValidationError("Generate a storyboard before media");
  const stages = stagesOf(loaded);
  if (!stages.video) {
    throw new ValidationError(
      "This project's generation mode does not render clips. Change it to Video segments first.",
    );
  }
  const scene = findScene(loaded, sceneId);
  const previous = chosenAttempt(loaded, sceneId);
  if (!previous) {
    throw new ValidationError(
      `Scene ${scene.sceneNumber} has no generated frames yet. Generate its media first.`,
    );
  }

  const continuity = resolveContinuity(loaded, scene);
  // `continue_video` builds the clip from the previous scene's clip rather than
  // from frames, so there is nothing of this scene's own to reuse.
  const continuing = Boolean(continuity.videoSource);
  if (!continuing && !previous.startImagePath) {
    throw new ValidationError(
      `Scene ${scene.sceneNumber} has no start frame to build a clip from. Regenerate its media instead.`,
    );
  }

  const manifest = await buildVideoManifest({
    sceneId,
    prompt: scene.prompts.videoPromptSegment,
    negativePrompt: scene.prompts.videoNegativePrompt,
    imageStart: previous.startImagePath,
    imageEnd: previous.endImagePath,
    videoSource: continuity.videoSource,
    modelStrategy: loaded.project.modelStrategy,
    modelType: loaded.project.videoModel,
    steps: loaded.project.videoSteps,
    frame: frameOf(loaded.project, "video"),
    loras: resolveSceneLoras(loaded.project, sceneId, "video"),
    durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
    soundscape: scene.prompts.videoSoundscape ?? scene.sfxNotes,
    score: scene.prompts.videoScore ?? scene.musicNotes,
    startFramePrompt: continuity.startImagePrompt ?? scene.prompts.startFramePrompt,
    endFramePrompt: scene.prompts.endFramePrompt,
    cast: await castFor(loaded, scene),
  });
  const job = await runToCompletion(manifest.settings);

  logEvent("scene.video_only", {
    projectId,
    sceneId,
    continuedFromVideo: continuing,
    reusedFrames: continuing ? 0 : previous.endImagePath ? 2 : 1,
  });

  const existing = loaded.attempts?.[sceneId] ?? [];
  const attempt: SceneAttempt = {
    ...previous,
    id: randomUUID(),
    attemptNumber: existing.length + 1,
    videoPath: job.generatedFiles[0],
    // The frames carry over untouched, so the settings that produced them stay
    // on the record; only the clip's manifest is new.
    settingsIds: [
      ...previous.settingsIds.filter((id) => id !== previous.settingsIds.at(-1)),
      manifest.id,
    ],
    approved: false,
    qcResult: undefined,
    createdAt: new Date().toISOString(),
  };

  return persistThenScore(projectId, scene, attempt, existing, loaded, true);
}

export type SceneMediaOptions = {
  /**
   * Called with the WanGP job id as soon as the backend returns it.
   *
   * The durable queue persists it here so a restart mid-render can poll the
   * job rather than resubmit it (SPEC-008 FR-2/FR-4).
   */
  onJobSubmitted?: (jobId: string) => Promise<void> | void;
};

/**
 * The cast a clip has to carry, or nothing when the tier does not use one.
 *
 * Gated on the tier rather than resolved unconditionally: the keyframe variants
 * inherit identity through `image_start` / `image_end` and are deliberately
 * sent no references, so resolving the cast for them is work with nowhere to go.
 */
async function castFor(record: ProjectRecord, scene: Scene): Promise<CastReference[] | undefined> {
  if (record.project.videoTier !== "ref2va") return undefined;
  return resolveCastSubjects(record, scene);
}

export async function generateSceneMedia(
  projectId: string,
  sceneId: string,
  options: SceneMediaOptions = {},
): Promise<ProjectRecord> {
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
  const imageRefs = await resolveCastReferenceImages(record, scene);
  // One subject per scene: the preset's prompt names "the woman", so a second
  // opted-in character has no unambiguous place to go.
  const swapSubject = await sceneFaceSwapSubject(record, scene);

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
   * in black trousers in one frame and blue jeans in the next. What the
   * reference may dictate depends on where it came from: see MATCH_INSTRUCTION.
   */
  const inheritedStart = Boolean(continuity.startImagePath);
  const conditionOnStartFrame = referencesStartFrame(record, sceneId, inheritedStart);
  const matchInstruction = changingWardrobe(record, sceneId)
    ? MATCH_INSTRUCTION.inheritedChangingWardrobe
    : MATCH_INSTRUCTION.inherited;

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
        frame: frameOf(record.project, "video"),
        loras: videoLoras,
        // The final scene is often shorter than a full segment.
        durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
        soundscape: scene.prompts.videoSoundscape ?? scene.sfxNotes,
        score: scene.prompts.videoScore ?? scene.musicNotes,
        startFramePrompt: continuity.startImagePrompt ?? scene.prompts.startFramePrompt,
        endFramePrompt: scene.prompts.endFramePrompt,
        cast: await castFor(record, scene),
      })
    : undefined;
  const videoJob = videoManifest
    ? await runToCompletion(videoManifest.settings, { onSubmitted: options.onJobSubmitted })
    : undefined;

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

export type ImportFrameResult = {
  record: ProjectRecord;
  /** The following scene whose carried-over start frame was replaced as well. */
  cascadedTo?: { sceneId: string; sceneNumber: number };
  /** This attempt's clip was built from the frame that has just been replaced. */
  clipStale: boolean;
};

/**
 * Put a supplied image in place of one of an attempt's rendered keyframes.
 *
 * Sometimes the picture already exists — a photograph, a still from elsewhere,
 * or StoryForge's own first render taken away and edited. Re-rolling a seed
 * until the model reproduces it is not a realistic way to get there.
 *
 * The frame is replaced on the latest attempt in place, exactly as a face swap
 * is, so everything that reads a frame path — the end-frame reference, the clip
 * build, the carried-over start frame of the next scene — picks it up without
 * knowing where the bytes came from. What it deliberately does not do is
 * re-render anything: the clip on this attempt was built from the frame that
 * has just been replaced, and saying so is the caller's job.
 */
export async function importAttemptFrame(
  projectId: string,
  sceneId: string,
  purpose: "start_frame" | "end_frame",
  file: File,
): Promise<ImportFrameResult> {
  const record = await getProjectRecord(projectId);
  const scene = findScene(record, sceneId);
  const attempts = record.attempts?.[sceneId] ?? [];
  const target = attempts.at(-1);
  if (!target) {
    throw new ValidationError(
      "Generate this scene's media first — an imported frame replaces one of an attempt's " +
        "keyframes, so there has to be an attempt to put it on.",
    );
  }

  const imported = await saveImportedFrame(projectId, file);

  // The swap provenance described the frame that has just gone. Left in place,
  // "undo" would quietly replace the imported image with an old render.
  const replaced: SceneAttempt = {
    ...target,
    ...(purpose === "start_frame"
      ? {
          startImagePath: imported,
          startImageSourcePath: undefined,
          startImageImported: true,
        }
      : {
          endImagePath: imported,
          endImageSourcePath: undefined,
          endImageImported: true,
        }),
  };

  const nextAttempts: Record<string, SceneAttempt[]> = {
    ...(record.attempts ?? {}),
    [sceneId]: attempts.map((a) => (a.id === target.id ? replaced : a)),
  };

  const cascadedTo = cascadeImportedEndFrame(record, scene, purpose, imported, nextAttempts);

  const updated: ProjectRecord = {
    ...record,
    attempts: nextAttempts,
    project: { ...record.project, updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      {
        at: new Date().toISOString(),
        action: "scene.frame_imported",
        detail: `Scene ${scene.sceneNumber} ${purpose.replace("_", " ")}`,
      },
    ],
  };

  await repository.update(projectId, updated);
  logEvent("scene.frame_imported", {
    projectId,
    sceneId,
    purpose,
    bytes: file.size,
    cascadedToSceneNumber: cascadedTo?.sceneNumber,
  });

  return {
    record: updated,
    cascadedTo,
    clipStale: Boolean(target.videoPath),
  };
}

/**
 * Carry an imported end frame into the next scene's start frame.
 *
 * On `reuse_end_frame` the next scene does not render a start frame at all — it
 * shows this one. Leaving its already-generated attempt pointing at the picture
 * that was just replaced would put the two scenes visibly out of step at the
 * cut, which is the single thing that mode exists to prevent.
 *
 * Only an attempt that actually carried the frame is touched. A scene that
 * rendered its own start frame owns it, and the seam rules that stopped it
 * inheriting the first time still apply.
 *
 * Mutates `attempts` in place; returns the scene it reached, if any.
 */
function cascadeImportedEndFrame(
  record: ProjectRecord,
  scene: Scene,
  purpose: "start_frame" | "end_frame",
  imported: string,
  attempts: Record<string, SceneAttempt[]>,
): { sceneId: string; sceneNumber: number } | undefined {
  if (purpose !== "end_frame") return undefined;
  if ((record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) !== "reuse_end_frame") {
    return undefined;
  }

  const next = record.storyboard?.scenes.find((s) => s.sceneNumber === scene.sceneNumber + 1);
  if (!next) return undefined;
  if (seamBreak(scene, next)) return undefined;

  const nextAttempts = attempts[next.id] ?? [];
  const nextTarget = nextAttempts.at(-1);
  if (!nextTarget?.startImageInherited) return undefined;

  attempts[next.id] = nextAttempts.map((a) =>
    a.id === nextTarget.id
      ? {
          ...a,
          startImagePath: imported,
          startImageSourcePath: undefined,
          startImageImported: true,
        }
      : a,
  );
  return { sceneId: next.id, sceneNumber: next.sceneNumber };
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
