import { getWangpClient, wangpEnabled } from "@/lib/wangp/factory";
import {
  findPinned,
  referenceImageCapacity,
  selectAudioModel,
  selectImageModel,
  selectVideoModel,
  supportsReferenceImages,
} from "@/lib/wangp/model-router";
import { resolveModel } from "@/lib/wangp/resolve-model";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { familyOfModel, supportsNegativePrompt } from "@/lib/wangp/family";
import { normaliseNegative, positiveConstraintClause } from "@/lib/agents/negative-prompt";
import {
  appendAudioProse,
  h3Mode,
  isH3Prompt,
  renderH3Prompt,
  stripH3Envelope,
  usesH3PromptFormat,
} from "@/lib/agents/h3-prompt";
import {
  H3_REFERENCE_MIN_WORDS,
  countWords,
  renderH3ReferencePrompt,
  stripH3ReferencePrompt,
  usesH3ReferenceFormat,
  type H3ReferenceSubject,
} from "@/lib/agents/h3-reference-prompt";
import { clipLengthGuidance } from "@/lib/wangp/clip-length";
import { resolveSteps } from "@/lib/wangp/steps";
import { resolveResolution, stepFloorFor, clampPreset, videoResolutionCeiling } from "@/lib/wangp/resolution";
import { appendTriggerWords, catalogForModel, reconcileLoras } from "@/lib/services/lora-service";
import type { ResolvedLora } from "@/lib/services/lora-service";
import type { LoraKind, LoraSelection } from "@/lib/schemas/lora";
import type { AspectRatio, ResolutionPreset } from "@/lib/types";
import { SEGMENT_SECONDS } from "@/lib/types";
import type {
  WangpGenerationSettings,
  WangpJob,
  WangpModel,
  WangpModelSchema,
  WangpPurpose,
} from "@/lib/schemas/wangp";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

export type WangpStatus = {
  enabled: boolean;
  mode: "mock" | "live";
  url: string;
  ok: boolean;
};

/**
 * The project settings that decide frame size and quality.
 *
 * Passed together because they only mean anything together: the aspect ratio
 * picks the shape and the preset picks the size along it.
 */
export type FrameOptions = {
  aspectRatio: AspectRatio;
  resolutionPreset: ResolutionPreset;
};

export async function getWangpStatus(): Promise<WangpStatus> {
  const client = getWangpClient();
  const ok = await client.health().catch(() => false);
  return { enabled: wangpEnabled(), mode: client.mode, url: config.wangp.url, ok };
}

export async function listWangpModels(
  output?: "image" | "video" | "audio",
): Promise<WangpModel[]> {
  const client = getWangpClient();
  const models = await client.listModels(output);
  logEvent("wangp.discovery", { output: output ?? "all", count: models.length });
  return models;
}

export async function getWangpModelSchema(modelType: string): Promise<WangpModelSchema> {
  return getWangpClient().getModelSchema(modelType);
}

/**
 * Check a selection against the model that was actually resolved.
 *
 * This has to happen here rather than in the caller: the manifest builders pick
 * the model themselves and may substitute the project's pin (see
 * `buildImageManifest`), so the caller does not know what the LoRAs will be
 * applied to.
 */
async function lorasFor(
  model: import("@/lib/schemas/wangp").WangpModel,
  selected: LoraSelection[] | undefined,
  sceneId: string,
  kind: LoraKind,
): Promise<ResolvedLora[]> {
  if (!selected?.length) return [];
  return reconcileLoras(selected, await catalogForModel(model), {
    sceneId,
    modelType: model.modelType,
    kind,
  });
}

/**
 * Fold a LoRA stack's trigger words into the prompt.
 *
 * Done here rather than in the stored scene prompt because the stack is only
 * known once the model is resolved: a substitution can drop LoRAs, and their
 * trigger words must go with them rather than lingering in the prompt.
 */
function withTriggerWords(prompt: string, loras: readonly ResolvedLora[]): string {
  if (!config.media.appendLoraTriggerWords) return prompt;
  return appendTriggerWords(prompt, loras);
}

/**
 * Deliver the exclusion in whatever form the chosen model can act on.
 *
 * The model is only known here, after resolution: a pin can be missing from the
 * catalogue and fall through to the router, so the family a prompt was written
 * for is not necessarily the family that renders it. On FLUX and Krea the
 * negative prompt is discarded by the model, so it is folded into the positive
 * prompt as the thing to render instead; everywhere else it is passed through,
 * normalised, because prompts written before this existed still carry prose
 * negations that a sampler cannot read.
 */
function routeNegative(
  model: Pick<WangpModel, "modelType" | "metadata">,
  prompt: string,
  negative: string | undefined,
  context: { sceneId: string; purpose: string },
): { prompt: string; negativePrompt: string | undefined } {
  const family = familyOfModel(model);
  const terms = negative?.trim() ? normaliseNegative(negative) : "";
  if (!terms) return { prompt, negativePrompt: negative };

  if (supportsNegativePrompt(family)) return { prompt, negativePrompt: terms };

  const clause = positiveConstraintClause(terms);
  logEvent("wangp.negative.folded", {
    ...context,
    modelType: model.modelType,
    family,
    terms: terms.split(", ").length,
  });
  return { prompt: `${prompt}${clause}`, negativePrompt: undefined };
}

/**
 * Put the prompt in MiniMax H3's native envelope, or take it back out again.
 *
 * Decided here for the same reason as `routeNegative`: a prompt is written for
 * the pinned family, and a pin missing from the catalogue falls through to the
 * router, so the family that renders is not always the one it was written for.
 * Handing `integrated_multimodal_description:` to a Wan model would render
 * those words rather than obey them, so the envelope is stripped back off
 * anywhere it does not belong.
 *
 * Doing it at render time also means the suffixes every prompt collects —
 * look, cast continuity, scene direction — are already appended and land
 * inside the timeline field, rather than after the last label where they would
 * break the format.
 */
function routeH3Format(
  model: Pick<WangpModel, "modelType" | "metadata">,
  prompt: string,
  args: {
    imageStart?: string;
    imageEnd?: string;
    durationSeconds?: number;
    soundscape?: string;
    score?: string;
  },
  context: { sceneId: string; purpose: string },
): string {
  const family = familyOfModel(model);
  const wanted = config.flags.h3NativePromptFormat && usesH3PromptFormat(family);
  if (!wanted) {
    const plain = stripH3Envelope(stripH3ReferencePrompt(prompt));
    // Dropping the layers here would leave H3 writing a soundtrack from no
    // direction at all, because its directive keeps them out of the timeline.
    return usesH3PromptFormat(family)
      ? appendAudioProse(plain, args.soundscape, args.score)
      : plain;
  }
  if (isH3Prompt(prompt)) return prompt;

  const hasStart = Boolean(args.imageStart);
  const hasEnd = Boolean(args.imageEnd);
  logEvent("wangp.h3_format.applied", {
    ...context,
    modelType: model.modelType,
    mode: h3Mode(hasStart, hasEnd),
  });

  return renderH3Prompt({
    body: prompt,
    soundscape: args.soundscape,
    score: args.score,
    durationSeconds: args.durationSeconds ?? SEGMENT_SECONDS,
    hasStart,
    hasEnd,
  });
}

/**
 * A character whose face this clip has to hold, and the photograph that fixes it.
 */
export type CastReference = {
  name: string;
  description?: string;
  /** Absolute path, readable by the WanGP process. */
  imagePath: string;
};

/**
 * How many characters one Ref2VA scene may pin.
 *
 * Every reference lengthens the same packed multimodal sequence, and the
 * measured cost is roughly seven minutes each: three characters is already a
 * thirty-minute clip. The cap is a refusal rather than a trim because quietly
 * dropping a character produces a clip where someone's face is simply wrong,
 * which looks like the model failing rather than a limit being hit.
 */
const REF2VA_MAX_CHARACTERS = 3;

/**
 * WanGP's step-skipping cache, at the strength a clean live run used.
 *
 * 28:56 -> 20:00 at 20 steps with no visible cost. The multiplier is not
 * optional decoration: the same cache at the 0.08 WanGP had saved skipped so
 * much of the denoising that the model dropped the prompt entirely.
 */
const REF2VA_STEP_SKIPPING = {
  cacheType: "spectrum",
  multiplier: 1.75,
  startStepPerc: 25,
} as const;

/**
 * Build the reference list and the subjects that name it.
 *
 * Order is the contract (FR-3): start frame, end frame, then one photograph per
 * character. WanGP emits `<Picture N>` in exactly this order and the prompt
 * refers to those numbers, so a reordering here silently re-labels every
 * reference in the prose.
 */
function composeRef2vaReferences(
  args: { imageStart?: string; imageEnd?: string; cast?: readonly CastReference[] },
  context: { sceneId: string; purpose: string },
): { imageRefs: string[]; subjects: H3ReferenceSubject[] } {
  // Both anchors, or none of this works. Ref2VA has no positional first frame —
  // the role is asserted in prose — and a live run with only a start frame lost
  // the composition entirely and pushed the referenced character into the
  // background. Falling back to FL2VA is the caller's decision, not ours.
  if (!args.imageStart || !args.imageEnd) {
    throw new ValidationError(
      "Reference mode needs both a start and an end frame: with only one anchor the model has " +
        "nothing holding the composition and renders the shot from the prompt alone. Render both " +
        "keyframes, or switch this project to first-and-last-frame mode.",
    );
  }

  const cast = args.cast ?? [];
  if (cast.length > REF2VA_MAX_CHARACTERS) {
    throw new ValidationError(
      `Reference mode holds at most ${REF2VA_MAX_CHARACTERS} characters per scene, and this one ` +
        `pins ${cast.length}. Each adds about seven minutes to the clip. Reduce the cast in this ` +
        "scene, or switch this project to first-and-last-frame mode.",
    );
  }

  const imageRefs = [args.imageStart, args.imageEnd, ...cast.map((member) => member.imagePath)];
  const subjects = cast.map((member, index) => ({
    name: member.name,
    description: member.description,
    // Two anchors occupy pictures 1 and 2, so the cast starts at 3.
    pictureIndex: index + 3,
  }));

  logEvent("wangp.ref2va.composed", {
    ...context,
    referenceCount: imageRefs.length,
    characterCount: cast.length,
  });

  return { imageRefs, subjects };
}

/**
 * Which video model a job will actually run on.
 *
 * Extracted so the settings screen can name what "Automatic" resolves to. A
 * picker that says "best ranked" without saying what that is leaves the user
 * unable to tell a sensible default from a wrong one, and the only thing worse
 * than not showing it is showing a second implementation's guess — so both go
 * through here.
 */
function pickVideoModel(
  models: WangpModel[],
  args: { modelType?: string; modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"] },
  options?: { log?: boolean },
): WangpModel {
  return resolveModel(
    models,
    args.modelType || config.wangp.videoModel,
    () => selectVideoModel(models, { modelStrategy: args.modelStrategy }),
    "video_segment",
    options,
  );
}

/**
 * Which image model a job will actually run on, references included.
 *
 * A pinned model that cannot accept references would silently drop them:
 * `buildSettingsManifest` only writes fields the schema declares, so the job
 * would render happily with no character conditioning and nothing to debug.
 * Model choice is therefore constrained while references are in play, and the
 * substitution is logged so it is visible rather than mysterious.
 */
function pickImageModel(
  models: WangpModel[],
  args: {
    modelType?: string;
    modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
    needsRefs: boolean;
    purpose: string;
  },
  options?: { log?: boolean },
): WangpModel {
  const pin = args.modelType || config.wangp.imageModel;
  const pinnedModel = findPinned(models, pin);
  const pinRejected = args.needsRefs && pinnedModel !== null && !supportsReferenceImages(pinnedModel);
  if (pinRejected && (options?.log ?? true)) {
    logEvent("wangp.model.selected", {
      purpose: args.purpose,
      pinned: pin,
      resolved: false,
      reason: "pinned_model_cannot_accept_reference_images",
    });
  }

  return resolveModel(
    models,
    pinRejected ? undefined : pin,
    () =>
      selectImageModel(models, { modelStrategy: args.modelStrategy }, {
        requireReferenceImages: args.needsRefs,
      }),
    args.purpose,
    options,
  );
}

/**
 * What the pickers above would choose right now, without choosing it.
 *
 * Returns null rather than throwing when nothing fits: this answers a question
 * the settings screen asked, and a screen that fails to load because no model
 * is installed is less useful than one that says so.
 */
export async function previewModelChoice(args: {
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
  imageModel?: string;
  videoModel?: string;
  needsReferenceImages?: boolean;
}): Promise<{ image: WangpModel | null; video: WangpModel | null }> {
  const client = getWangpClient();
  const [imageModels, videoModels] = await Promise.all([
    client.listModels("image"),
    client.listModels("video"),
  ]);

  const attempt = <T>(pick: () => T): T | null => {
    try {
      return pick();
    } catch {
      return null;
    }
  };

  return {
    image: attempt(() =>
      pickImageModel(
        imageModels,
        {
          modelType: args.imageModel,
          modelStrategy: args.modelStrategy,
          needsRefs: Boolean(args.needsReferenceImages),
          purpose: "start_frame",
        },
        { log: false },
      ),
    ),
    video: attempt(() =>
      pickVideoModel(
        videoModels,
        { modelType: args.videoModel, modelStrategy: args.modelStrategy },
        { log: false },
      ),
    ),
  };
}

/**
 * Discovery-first manifest build: pick a video model that supports start frames,
 * fetch its schema, then override only validated fields (spec Section 11.3).
 */
export async function buildVideoManifest(args: {
  sceneId: string;
  prompt: string;
  negativePrompt?: string;
  imageStart?: string;
  imageEnd?: string;
  /** Previous scene's clip to continue from, for `continue_video` continuity. */
  videoSource?: string;
  /** LoRAs selected for this scene's video generation. */
  loras?: LoraSelection[];
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
  /** Per-project pin. Outranks the env pin; falls through to the router. */
  modelType?: string;
  fps?: number;
  /** Segment length; the last scene may be shorter than a full segment. */
  durationSeconds?: number;
  /** Per-project step override. Undefined lets `resolveSteps` decide. */
  steps?: number;
  /** Project aspect ratio and quality preset. */
  frame?: FrameOptions;
  /** Ambience and audience-only score, for the families that field them apart. */
  soundscape?: string;
  score?: string;
  /**
   * Characters whose identity this clip must hold throughout, with their
   * photographs. Only consumed by the reference variant; the keyframe variants
   * inherit identity from the two frames and are sent none.
   */
  cast?: readonly CastReference[];
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const videoModels = await client.listModels("video");
  const model = pickVideoModel(videoModels, args);
  const schema = await client.getModelSchema(model.modelType);
  const loras = await lorasFor(model, args.loras, args.sceneId, "video");
  const context = { sceneId: args.sceneId, purpose: "video_segment" as const };
  const routed = routeNegative(
    model,
    withTriggerWords(args.prompt, loras),
    args.negativePrompt,
    context,
  );

  const family = familyOfModel(model);

  // Reference mode replaces the keyframe pathway rather than adding to it: this
  // checkpoint declares no image_start or image_end at all, so the two frames
  // have to travel as references or not at all.
  const reference = usesH3ReferenceFormat(family)
    ? composeRef2vaReferences(args, context)
    : undefined;

  const prompt = reference
    ? renderH3ReferencePrompt({
        body: stripH3Envelope(routed.prompt),
        subjects: reference.subjects,
        hasStart: true,
        hasEnd: true,
        soundscape: args.soundscape,
        score: args.score,
      })
    : routeH3Format(model, routed.prompt, args, context);

  if (reference && countWords(routed.prompt) < H3_REFERENCE_MIN_WORDS) {
    // Not padded to reach the floor: length has to come from describing more
    // closely, and the only thing a renderer could add is filler.
    logEvent("wangp.ref2va.short_prompt", {
      ...context,
      words: countWords(routed.prompt),
      floor: H3_REFERENCE_MIN_WORDS,
    });
  }

  // A heavy model can make its own quality preset impractical, so the request
  // is held at the model's ceiling. Only ever downward — see `clampPreset`.
  const requested = args.frame?.resolutionPreset ?? "standard";
  const ceiling = videoResolutionCeiling(family);
  const preset = clampPreset(requested, ceiling);
  const clamped = preset !== requested;
  if (clamped) {
    logEvent("wangp.resolution.clamped", {
      ...context,
      modelType: model.modelType,
      requested,
      preset,
    });
  }
  // Built rather than only patched: a caller with no frame options still has a
  // preset — the default one — and dropping the object here threw the clamp
  // away while the telemetry above went on reporting that it had been applied.
  const frame: FrameOptions = {
    aspectRatio: args.frame?.aspectRatio ?? (config.defaults.aspectRatio as AspectRatio),
    resolutionPreset: preset,
  };

  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: "video_segment",
    prompt,
    negativePrompt: routed.negativePrompt,
    imageStart: reference ? undefined : args.imageStart,
    imageEnd: reference ? undefined : args.imageEnd,
    imageRefs: reference?.imageRefs,
    // "I" — references are people and objects. Taken from the metadata WanGP
    // wrote beside a hand-made Ref2VA render that came out correct, on this
    // same checkpoint. "KI" moved which picture the model read as the opening
    // frame, and an empty value had the references ignored altogether.
    imageRefsLeadWithScene: reference ? false : undefined,
    videoSource: args.videoSource,
    loras,
    fps: args.fps ?? config.defaults.fps,
    durationSeconds: args.durationSeconds,
    // A hard stop rather than a stitch point: this variant has no sliding
    // windows, so there is no longer clip to be had at any quality.
    maxFrames: clipLengthGuidance(family)?.maxFrames,
    // Only ever alongside the model's full step count — see FR-5d. `stepsFor`
    // below is what guarantees that, which is why this is not offered as a
    // speed/quality trade the caller can get wrong.
    stepSkipping: reference ? REF2VA_STEP_SKIPPING : undefined,
    resolution: resolutionFor(schema, frame, { ...context, modelType: model.modelType }),
    // Rendering small is only half of the low-resolution strategy; without the
    // upscale it is just a small clip. WanGP holds this as saved UI state, so
    // it is written rather than inherited.
    spatialUpsampling: clamped ? config.media.videoSpatialUpsampling : undefined,
    steps: stepsFor(
      model.modelType,
      schema,
      loras,
      args.steps,
      stepFloorFor(preset, config.wangp.minVideoSteps),
      context,
    ),
  });
}

/**
 * The frame size for a job, snapped to what the model actually offers.
 *
 * Logged for the same reason as the step count: a project set to 9:16 that
 * renders landscape is obvious in the output and invisible in the settings.
 */
function resolutionFor(
  schema: WangpModelSchema,
  frame: FrameOptions | undefined,
  context: { sceneId: string; purpose: WangpPurpose; modelType: string },
): string {
  const allowed = schema.fields.find((field) => field.name === "resolution")?.allowed;
  const resolution = resolveResolution({
    aspectRatio: frame?.aspectRatio ?? config.defaults.aspectRatio as AspectRatio,
    preset: frame?.resolutionPreset ?? "standard",
    fallback: config.defaults.resolution,
    allowed: allowed?.map(String),
  });

  logEvent("wangp.resolution.resolved", {
    ...context,
    resolution,
    aspectRatio: frame?.aspectRatio,
    preset: frame?.resolutionPreset,
  });
  return resolution;
}

/**
 * Decide the step count and say why.
 *
 * Logged because a step count that changes underneath you is invisible: the job
 * succeeds, the image is just wrong, and nothing in the output points at the
 * cause.
 */
function stepsFor(
  modelType: string,
  schema: WangpModelSchema,
  loras: readonly ResolvedLora[],
  override: number | undefined,
  floor: number,
  context: { sceneId: string; purpose: WangpPurpose },
): number | undefined {
  const raw = schema.defaultSettings.num_inference_steps;
  const resolution = resolveSteps({
    modelType,
    modelDefault: typeof raw === "number" ? raw : undefined,
    loras,
    override,
    floor,
  });
  if (!resolution) return undefined;

  logEvent("wangp.steps.resolved", {
    ...context,
    modelType,
    steps: resolution.steps,
    reason: resolution.reason,
    modelDefault: raw,
  });
  return resolution.steps;
}

export async function submitJob(settings: Record<string, unknown>): Promise<WangpJob> {
  const job = await getWangpClient().generate(settings);
  logEvent("wangp.job.submitted", { jobId: job.id });
  return job;
}

export async function getJob(jobId: string): Promise<WangpJob> {
  const job = await getWangpClient().getJob(jobId);
  logEvent("wangp.job.polled", { jobId, status: job.status });
  return job;
}

export async function cancelJob(jobId: string): Promise<WangpJob> {
  return getWangpClient().cancelJob(jobId);
}

const TERMINAL: WangpJob["status"][] = ["completed", "failed", "cancelled"];

const delay = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * WanGP holds a single generation session: submitting while another job is
 * running fails with "session already has a generation in progress". Every
 * submission is therefore serialized through this chain, so a user generating
 * several scenes at once queues instead of colliding.
 *
 * This only protects a single app process. A second StoryForge instance, or the
 * WanGP web UI, can still take the session.
 */
const globalQueue = globalThis as unknown as { __storyforgeWangpQueue?: Promise<unknown> };

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalQueue.__storyforgeWangpQueue ?? Promise.resolve();
  // Swallow the predecessor's failure so one bad job cannot poison the queue.
  const run = previous.catch(() => undefined).then(task);
  globalQueue.__storyforgeWangpQueue = run.catch(() => undefined);
  return run;
}

/** True when WanGP refused because another generation already holds the session. */
export function isSessionBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /generation in progress/i.test(message);
}

/**
 * Submit a job and poll until it reaches a terminal state (spec Section 8.2).
 *
 * The mock client completes in two polls, so demo mode stays instant. Live
 * generation takes minutes, so the live path uses the configured interval and
 * attempt budget instead of a tight loop.
 */
export type RunOptions = {
  maxPolls?: number;
  /**
   * Called the instant the backend returns a job id, before any polling.
   *
   * SPEC-008 FR-2: this is the only moment at which an accepted job becomes
   * recoverable. Anything awaited here delays the first poll, so the durable
   * queue uses it to persist the id and nothing else.
   */
  onSubmitted?: (jobId: string) => Promise<void> | void;
};

export async function runToCompletion(
  settings: Record<string, unknown>,
  maxPollsOrOptions?: number | RunOptions,
): Promise<WangpJob> {
  const options: RunOptions =
    typeof maxPollsOrOptions === "number" ? { maxPolls: maxPollsOrOptions } : (maxPollsOrOptions ?? {});
  const client = getWangpClient();
  const live = client.mode === "live";
  const attempts = options.maxPolls ?? (live ? config.wangp.maxPollAttempts : 10);
  const intervalMs = live ? config.wangp.pollIntervalMs : 0;

  return enqueue(async () => {
    let job: WangpJob;
    try {
      job = await client.generate(settings);
    } catch (err) {
      if (isSessionBusyError(err)) {
        throw new Error(
          "WanGP is already generating. It runs one job at a time — wait for the " +
            "current job, or cancel it (its web UI or wangp_cancel_job) and retry.",
        );
      }
      throw err;
    }
    logEvent("wangp.job.submitted", { jobId: job.id, mode: client.mode });
    // Persisted before the first poll: a crash after this point is resumable,
    // a crash before it is not, and that distinction is the whole of FR-11.
    await options.onSubmitted?.(job.id);

    for (let i = 0; i < attempts && !TERMINAL.includes(job.status); i += 1) {
      await delay(intervalMs);
      job = await client.getJob(job.id);
    }

    logEvent("wangp.job.polled", { jobId: job.id, status: job.status });
    if (!TERMINAL.includes(job.status)) {
      // Leaving it running would block every later job, so release the session.
      await client.cancelJob(job.id).catch(() => undefined);
      throw new Error(`WanGP job ${job.id} did not finish within ${attempts} polls; cancelled.`);
    }
    if (job.status !== "completed") {
      throw new Error(job.errors[0] ?? `WanGP job ${job.id} ${job.status}.`);
    }
    return job;
  });
}

/**
 * Ask the backend what became of a job we submitted before a restart (FR-4).
 *
 * Never resubmits. A job the backend has forgotten returns `unknown`, which the
 * caller must escalate to a person rather than guessing.
 */
export async function resumeJob(
  jobId: string,
): Promise<{ status: WangpJob["status"] | "unknown"; job?: WangpJob }> {
  try {
    const job = await getWangpClient().getJob(jobId);
    return { status: job.status, job };
  } catch {
    return { status: "unknown" };
  }
}

/** Build an image keyframe manifest (start or end frame). */
export async function buildImageManifest(args: {
  sceneId: string;
  purpose: Extract<WangpPurpose, "start_frame" | "end_frame">;
  prompt: string;
  negativePrompt?: string;
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
  /** Per-project pin. Outranks the env pin; falls through to the router. */
  modelType?: string;
  /**
   * Absolute paths to character reference images. When present the model must
   * accept `image_refs`, so an incompatible pin is overridden rather than
   * honoured — see below.
   */
  imageRefs?: string[];
  /** Set when the first reference is a scene frame rather than a person. */
  imageRefsLeadWithScene?: boolean;
  /** LoRAs selected for this scene's keyframe generation. */
  loras?: LoraSelection[];
  /** Pinned seed, so a preview and the real render sample identically. */
  seed?: number;
  /** Per-project step override. Undefined lets `resolveSteps` decide. */
  steps?: number;
  /** Project aspect ratio and quality preset. */
  frame?: FrameOptions;
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const imageModels = await client.listModels("image");
  const needsRefs = Boolean(args.imageRefs?.length);

  const model = pickImageModel(imageModels, {
    modelType: args.modelType,
    modelStrategy: args.modelStrategy,
    needsRefs,
    purpose: args.purpose,
  });

  if (needsRefs && !supportsReferenceImages(model)) {
    throw new ValidationError(
      `No installed image model accepts reference images, so the pinned characters ` +
        `cannot be applied. Install a reference-capable model (for example ` +
        `Flux 2 Klein or Qwen Image Edit), or turn off the character library for this project.`,
    );
  }

  const schema = await client.getModelSchema(model.modelType);
  const loras = await lorasFor(model, args.loras, args.sceneId, "image");

  // Trimmed against the resolved model, not the pin, because the model may have
  // been substituted above. A leading scene frame outranks the cast portraits.
  const capacity = referenceImageCapacity(model);
  const imageRefs = args.imageRefs?.slice(0, capacity);
  if (args.imageRefs && imageRefs && imageRefs.length < args.imageRefs.length) {
    logEvent("wangp.reference_images.trimmed", {
      purpose: args.purpose,
      modelType: model.modelType,
      supplied: args.imageRefs.length,
      sent: imageRefs.length,
    });
  }

  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: args.purpose,
    ...routeNegative(model, withTriggerWords(args.prompt, loras), args.negativePrompt, {
      sceneId: args.sceneId,
      purpose: args.purpose,
    }),
    imageRefs,
    imageRefsLeadWithScene: args.imageRefsLeadWithScene,
    loras,
    resolution: resolutionFor(schema, args.frame, {
      sceneId: args.sceneId,
      purpose: args.purpose,
      modelType: model.modelType,
    }),
    seed: args.seed,
    steps: stepsFor(
      model.modelType,
      schema,
      loras,
      args.steps,
      stepFloorFor(args.frame?.resolutionPreset ?? "standard", config.wangp.minImageSteps),
      { sceneId: args.sceneId, purpose: args.purpose },
    ),
  });
}

/**
 * Build a manifest for a dedicated audio model (ACE-Step, Stable Audio 3).
 * Reached through the same `wangp_generate` tool as image and video work.
 */
export async function buildAudioManifest(args: {
  sceneId: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const audioModels = await client.listModels("audio");
  const model = resolveModel(
    audioModels,
    config.wangp.audioModel,
    () => selectAudioModel(audioModels, { modelStrategy: args.modelStrategy }),
    "audio",
  );
  const schema = await client.getModelSchema(model.modelType);
  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: "audio",
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    durationSeconds: args.durationSeconds,
  });
}
