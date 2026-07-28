import { getWangpClient, wangpEnabled } from "@/lib/wangp/factory";
import {
  findPinned,
  selectAudioModel,
  selectImageModel,
  selectVideoModel,
  supportsReferenceImages,
} from "@/lib/wangp/model-router";
import { resolveModel } from "@/lib/wangp/resolve-model";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { catalogForModel, reconcileLoras } from "@/lib/services/lora-service";
import type { LoraKind, LoraSelection } from "@/lib/schemas/lora";
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
): Promise<LoraSelection[]> {
  if (!selected?.length) return [];
  return reconcileLoras(selected, await catalogForModel(model), {
    sceneId,
    modelType: model.modelType,
    kind,
  });
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
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const videoModels = await client.listModels("video");
  const model = resolveModel(
    videoModels,
    args.modelType || config.wangp.videoModel,
    () => selectVideoModel(videoModels, { modelStrategy: args.modelStrategy }),
    "video_segment",
  );
  const schema = await client.getModelSchema(model.modelType);
  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: "video_segment",
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    imageStart: args.imageStart,
    imageEnd: args.imageEnd,
    videoSource: args.videoSource,
    loras: await lorasFor(model, args.loras, args.sceneId, "video"),
    fps: args.fps ?? config.defaults.fps,
    durationSeconds: args.durationSeconds,
    resolution: config.defaults.resolution,
  });
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
export async function runToCompletion(
  settings: Record<string, unknown>,
  maxPolls?: number,
): Promise<WangpJob> {
  const client = getWangpClient();
  const live = client.mode === "live";
  const attempts = maxPolls ?? (live ? config.wangp.maxPollAttempts : 10);
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
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const imageModels = await client.listModels("image");
  const needsRefs = Boolean(args.imageRefs?.length);

  // A pinned model that cannot accept references would silently drop them:
  // `buildSettingsManifest` only writes fields the schema declares, so the job
  // would render happily with no character conditioning and nothing to debug.
  // Model choice is therefore constrained while references are in play, and the
  // substitution is logged so it is visible rather than mysterious.
  const pin = args.modelType || config.wangp.imageModel;
  const pinnedModel = findPinned(imageModels, pin);
  const pinRejected = needsRefs && pinnedModel !== null && !supportsReferenceImages(pinnedModel);
  if (pinRejected) {
    logEvent("wangp.model.selected", {
      purpose: args.purpose,
      pinned: pin,
      resolved: false,
      reason: "pinned_model_cannot_accept_reference_images",
    });
  }

  const model = resolveModel(
    imageModels,
    pinRejected ? undefined : pin,
    () => selectImageModel(imageModels, { modelStrategy: args.modelStrategy }, {
      requireReferenceImages: needsRefs,
    }),
    args.purpose,
  );

  if (needsRefs && !supportsReferenceImages(model)) {
    throw new ValidationError(
      `No installed image model accepts reference images, so the pinned characters ` +
        `cannot be applied. Install a reference-capable model (for example ` +
        `Flux 2 Klein or Qwen Image Edit), or turn off the character library for this project.`,
    );
  }

  const schema = await client.getModelSchema(model.modelType);
  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: args.purpose,
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    imageRefs: args.imageRefs,
    imageRefsLeadWithScene: args.imageRefsLeadWithScene,
    loras: await lorasFor(model, args.loras, args.sceneId, "image"),
    resolution: config.defaults.resolution,
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
