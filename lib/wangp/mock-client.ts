import { randomUUID } from "node:crypto";
import type { WangpClient } from "@/lib/wangp/client";
import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";
import { produces } from "@/lib/wangp/model-router";

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
    modelType: "ltx2_22B",
    name: "LTX-2 22B (video + audio)",
    metadata: {
      mainOutput: "video",
      // Mirrors the real WanGP record: LTX-2 switches between stills and
      // motion and renders a soundtrack, so it lists all three outputs.
      outputs: ["image", "video", "audio"],
      inputs: ["text", "image", "audio"],
      mediaInputs: {
        image: { start: true, end: true },
        // Real LTX-2 advertises continuation, which drives the
        // `continue_video` scene continuity mode.
        video: { continue: true, last: true },
        audio: { prompt: true, output: true },
      },
      supportsLora: true,
      vramProfile: "high",
      qualityRank: 88,
      recommendedFps: [24, 25],
      maxFrames: 481,
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
  {
    modelType: "stable_audio3_small",
    name: "Stable Audio 3 Small (music)",
    metadata: {
      mainOutput: "audio",
      outputs: ["audio"],
      inputs: ["text"],
      mediaInputs: { audio: { output: true } },
      vramProfile: "low",
      qualityRank: 75,
    },
  },
  {
    modelType: "chatterbox",
    name: "Chatterbox (TTS)",
    metadata: {
      mainOutput: "audio",
      outputs: ["audio"],
      inputs: ["text", "audio"],
      mediaInputs: { audio: { prompt: true, output: true } },
      vramProfile: "low",
      qualityRank: 70,
    },
  },
];

function defaultSettingsFor(model: WangpModel): WangpModelSchema {
  if (model.metadata.mainOutput === "image") {
    // Mirror the live client: a model that advertises reference-image input
    // gets `image_refs` plus the `video_prompt_type` letter that activates it,
    // so demo mode exercises the same manifest branch as a real WanGP.
    const acceptsRefs = Boolean(model.metadata.mediaInputs?.image?.reference);
    return {
      modelType: model.modelType,
      defaultSettings: {
        model_type: model.modelType,
        prompt: "",
        negative_prompt: "",
        resolution: "1280x720",
        num_inference_steps: 20,
        // -1 is WanGP's "pick one for me". Present so demo mode exercises the
        // seed-pinning branch that keeps a preview predicting its keyframe.
        seed: -1,
        ...(acceptsRefs ? { video_prompt_type: "" } : {}),
      },
      fields: [
        { name: "prompt", type: "string" },
        { name: "negative_prompt", type: "string" },
        { name: "resolution", type: "string", allowed: ["1280x720", "1024x1024", "720x1280"] },
        { name: "num_inference_steps", type: "number" },
        { name: "seed", type: "number" },
        ...(acceptsRefs
          ? [
              { name: "image_refs", type: "array" },
              { name: "video_prompt_type", type: "string" },
            ]
          : []),
      ],
    };
  }
  if (model.metadata.mainOutput === "audio") {
    return {
      modelType: model.modelType,
      defaultSettings: {
        model_type: model.modelType,
        prompt: "",
        negative_prompt: "",
        duration_seconds: 30,
        num_inference_steps: 8,
        guidance_scale: 1,
      },
      fields: [
        { name: "prompt", type: "string" },
        { name: "negative_prompt", type: "string" },
        { name: "duration_seconds", type: "number", min: 1, max: 120 },
        { name: "num_inference_steps", type: "number" },
        { name: "guidance_scale", type: "number" },
      ],
    };
  }
  // Mirror the live normalizer: continuation is advertised as a capability
  // flag, and `image_prompt_type` ships pre-set (LTX-2 defaults to "SE"), which
  // is why continuing has to override it rather than add to it.
  const canContinue = Boolean(model.metadata.mediaInputs?.video?.continue);
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
      ...(canContinue ? { image_prompt_type: "SE" } : {}),
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
      ...(canContinue
        ? [
            { name: "video_source", type: "string" },
            { name: "image_prompt_type", type: "string" },
          ]
        : []),
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
    // Filter on the full output list, not just mainOutput: a model that
    // switches between stills and motion (LTX-2) must appear in both.
    return mainOutput ? MODELS.filter((m) => produces(m, mainOutput)) : MODELS;
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
