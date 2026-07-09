import { getWangpClient, wangpEnabled } from "@/lib/wangp/factory";
import { selectImageModel, selectVideoModel } from "@/lib/wangp/model-router";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import type {
  WangpGenerationSettings,
  WangpJob,
  WangpModel,
  WangpModelSchema,
  WangpPurpose,
} from "@/lib/schemas/wangp";
import { config } from "@/lib/config";
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
 * Discovery-first manifest build: pick a video model that supports start frames,
 * fetch its schema, then override only validated fields (spec Section 11.3).
 */
export async function buildVideoManifest(args: {
  sceneId: string;
  prompt: string;
  negativePrompt?: string;
  imageStart?: string;
  imageEnd?: string;
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
  fps?: number;
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const videoModels = await client.listModels("video");
  const model = selectVideoModel(videoModels, { modelStrategy: args.modelStrategy });
  if (!model) throw new Error("No suitable video model available");
  const schema = await client.getModelSchema(model.modelType);
  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: "video_segment",
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    imageStart: args.imageStart,
    imageEnd: args.imageEnd,
    fps: args.fps ?? config.defaults.fps,
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

/** Submit a job and poll until it reaches a terminal state (spec Section 8.2). */
export async function runToCompletion(
  settings: Record<string, unknown>,
  maxPolls = 10,
): Promise<WangpJob> {
  const client = getWangpClient();
  let job = await client.generate(settings);
  logEvent("wangp.job.submitted", { jobId: job.id });
  for (let i = 0; i < maxPolls && !TERMINAL.includes(job.status); i += 1) {
    job = await client.getJob(job.id);
  }
  logEvent("wangp.job.polled", { jobId: job.id, status: job.status });
  return job;
}

/** Build an image keyframe manifest (start or end frame). */
export async function buildImageManifest(args: {
  sceneId: string;
  purpose: Extract<WangpPurpose, "start_frame" | "end_frame">;
  prompt: string;
  negativePrompt?: string;
  modelStrategy: import("@/lib/schemas/project").Project["modelStrategy"];
}): Promise<WangpGenerationSettings> {
  const client = getWangpClient();
  const imageModels = await client.listModels("image");
  const model = selectImageModel(imageModels, { modelStrategy: args.modelStrategy });
  if (!model) throw new Error("No suitable image model available");
  const schema = await client.getModelSchema(model.modelType);
  return buildSettingsManifest(schema, {
    sceneId: args.sceneId,
    purpose: args.purpose,
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    resolution: config.defaults.resolution,
  });
}
