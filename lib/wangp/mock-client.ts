import { randomUUID } from "node:crypto";
import type { WangpClient } from "@/lib/wangp/client";
import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Deterministic in-memory WanGP client. Mirrors the real MCP tool surface so the
 * app runs fully local; jobs advance submitted -> running -> completed across
 * successive polls to simulate progress.
 */

const MODELS: WangpModel[] = [
  {
    modelType: "flux_dev_image",
    name: "Flux Dev (image)",
    metadata: {
      mainOutput: "image",
      inputs: ["text"],
      supportsLora: true,
      vramProfile: "medium",
      qualityRank: 80,
    },
  },
  {
    modelType: "qwen_image",
    name: "Qwen Image",
    metadata: {
      mainOutput: "image",
      inputs: ["text", "image"],
      mediaInputs: { image: { reference: true } },
      vramProfile: "low",
      qualityRank: 72,
    },
  },
  {
    modelType: "wan_i2v_14b",
    name: "Wan 2.1 I2V 14B",
    metadata: {
      mainOutput: "video",
      inputs: ["text", "image"],
      mediaInputs: { image: { start: true, end: true, reference: true } },
      supportsLora: true,
      vramProfile: "high",
      qualityRank: 90,
      recommendedFps: [16, 24],
      maxFrames: 481,
    },
  },
  {
    modelType: "ltx_video",
    name: "LTX Video",
    metadata: {
      mainOutput: "video",
      inputs: ["text", "image"],
      mediaInputs: { image: { start: true } },
      vramProfile: "medium",
      qualityRank: 78,
      recommendedFps: [24, 30],
      maxFrames: 601,
    },
  },
  {
    modelType: "hunyuan_video",
    name: "Hunyuan Video",
    metadata: {
      mainOutput: "video",
      inputs: ["text"],
      vramProfile: "high",
      qualityRank: 82,
      recommendedFps: [24],
      maxFrames: 481,
    },
  },
];

function defaultSettingsFor(model: WangpModel): WangpModelSchema {
  if (model.metadata.mainOutput === "image") {
    return {
      modelType: model.modelType,
      defaultSettings: {
        model_type: model.modelType,
        prompt: "",
        negative_prompt: "",
        resolution: "1280x720",
        num_inference_steps: 20,
      },
      fields: [
        { name: "prompt", type: "string" },
        { name: "negative_prompt", type: "string" },
        { name: "resolution", type: "string", allowed: ["1280x720", "1024x1024", "720x1280"] },
        { name: "num_inference_steps", type: "number" },
      ],
    };
  }
  return {
    modelType: model.modelType,
    defaultSettings: {
      model_type: model.modelType,
      prompt: "",
      negative_prompt: "",
      resolution: "1280x720",
      force_fps: model.metadata.recommendedFps?.[0] ?? 24,
      video_length: model.metadata.maxFrames ?? 481,
      num_inference_steps: 8,
    },
    fields: [
      { name: "prompt", type: "string" },
      { name: "negative_prompt", type: "string" },
      { name: "resolution", type: "string", allowed: ["1280x720", "720x1280", "1024x1024"] },
      { name: "force_fps", type: "number", allowed: model.metadata.recommendedFps ?? [24] },
      { name: "video_length", type: "number" },
      { name: "num_inference_steps", type: "number" },
      { name: "image_start", type: "string" },
      { name: "image_end", type: "string" },
    ],
  };
}

type MockJob = WangpJob & { polls: number };

export class MockWangpClient implements WangpClient {
  readonly mode = "mock" as const;
  private readonly jobs: Map<string, MockJob>;

  constructor(jobs?: Map<string, MockJob>) {
    this.jobs = jobs ?? new Map();
  }

  async listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]> {
    return mainOutput ? MODELS.filter((m) => m.metadata.mainOutput === mainOutput) : MODELS;
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    const model = MODELS.find((m) => m.modelType === modelType);
    if (!model) throw new Error(`Unknown model_type: ${modelType}`);
    return defaultSettingsFor(model);
  }

  async generate(settings: Record<string, unknown>): Promise<WangpJob> {
    const id = randomUUID();
    const job: MockJob = {
      id,
      status: "submitted",
      progress: 0,
      generatedFiles: [],
      errors: [],
      polls: 0,
    };
    this.jobs.set(id, job);
    void settings;
    return this.strip(job);
  }

  async getJob(jobId: string): Promise<WangpJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.status === "submitted" || job.status === "running") {
      job.polls += 1;
      if (job.polls >= 2) {
        job.status = "completed";
        job.progress = 100;
        job.generatedFiles = [`/.wangp-mock/${jobId}.out`];
      } else {
        job.status = "running";
        job.progress = 50;
      }
      this.jobs.set(jobId, job);
    }
    return this.strip(job);
  }

  async cancelJob(jobId: string): Promise<WangpJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    job.status = "cancelled";
    this.jobs.set(jobId, job);
    return this.strip(job);
  }

  async health(): Promise<boolean> {
    return true;
  }

  private strip(job: MockJob): WangpJob {
    const { polls: _polls, ...rest } = job;
    return { ...rest };
  }
}
