import { z } from "zod";

/** WanGP model as returned by MCP discovery (spec Section 5.2 / 11.3). */
export const wangpModelSchema = z.object({
  modelType: z.string(),
  name: z.string(),
  metadata: z.object({
    mainOutput: z.enum(["image", "video", "audio"]),
    /**
     * Everything the model emits. A video model that also renders a soundtrack
     * (WanGP `returns_audio`, e.g. LTX-2) reports ["video", "audio"].
     */
    outputs: z.array(z.enum(["image", "video", "audio"])).optional(),
    inputs: z.array(z.enum(["text", "image", "video", "audio"])),
    mediaInputs: z
      .object({
        image: z
          .object({
            start: z.boolean().optional(),
            end: z.boolean().optional(),
            reference: z.boolean().optional(),
          })
          .optional(),
        audio: z
          .object({
            /** Accepts an audio prompt / voice sample (lip-sync, voice cloning). */
            prompt: z.boolean().optional(),
            /** Produces an audio track. */
            output: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    supportsLora: z.boolean().optional(),
    /**
     * Whether the weights are present locally. WanGP happily accepts a job for
     * a model it does not have and downloads it first, which can mean tens of
     * gigabytes before anything renders.
     */
    availability: z.enum(["available", "partial", "missing"]).optional(),
    vramProfile: z.enum(["low", "medium", "high"]).optional(),
    qualityRank: z.number().optional(),
    recommendedFps: z.array(z.number()).optional(),
    maxFrames: z.number().optional(),
  }),
});
export type WangpModel = z.infer<typeof wangpModelSchema>;

export const wangpFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  allowed: z.array(z.unknown()).optional(),
  /** Published numeric bounds, when the model schema declares them. */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

export const wangpModelSchemaSchema = z.object({
  modelType: z.string(),
  defaultSettings: z.record(z.unknown()),
  fields: z.array(wangpFieldSchema),
});
export type WangpModelSchema = z.infer<typeof wangpModelSchemaSchema>;

export const WANGP_JOB_STATUSES = [
  "submitted",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const wangpJobStatusSchema = z.enum(WANGP_JOB_STATUSES);

export const wangpJobSchema = z.object({
  id: z.string(),
  status: wangpJobStatusSchema,
  progress: z.number().min(0).max(100),
  generatedFiles: z.array(z.string()),
  errors: z.array(z.string()),
});
export type WangpJob = z.infer<typeof wangpJobSchema>;

/** Capability tags derived from a WanGP model (spec Section 2A.8). */
export const modelCapabilitySchema = z.object({
  modelType: z.string(),
  provider: z.enum(["wangp", "external"]),
  outputs: z.array(z.enum(["image", "video", "audio", "voice", "lip_sync", "postprocess"])),
  inputs: z.array(z.enum(["text", "image", "video", "audio"])),
  supportsStartFrame: z.boolean(),
  supportsEndFrame: z.boolean(),
  supportsReferenceImages: z.boolean(),
  supportsLora: z.boolean(),
  /** Emits an audio track of its own (WanGP `returns_audio` / `audio_only`). */
  supportsAudioOutput: z.boolean(),
  /** Accepts an audio prompt or voice sample as input. */
  acceptsAudioPrompt: z.boolean(),
  maxFrames: z.number().optional(),
  recommendedFps: z.array(z.number()).optional(),
  vramProfile: z.enum(["low", "medium", "high"]).optional(),
  qualityRank: z.number().optional(),
});
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const WANGP_PURPOSES = [
  "start_frame",
  "end_frame",
  "video_segment",
  "audio",
  "postprocess",
] as const;
export const wangpPurposeSchema = z.enum(WANGP_PURPOSES);
export type WangpPurpose = (typeof WANGP_PURPOSES)[number];

/** WanGP generation settings manifest (spec Section 6.6). */
export const wangpGenerationSettingsSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  purpose: wangpPurposeSchema,
  modelType: z.string(),
  settings: z.record(z.unknown()),
  mcpJobId: z.string().optional(),
  status: z.enum(["draft", "submitted", "running", "completed", "failed", "cancelled"]),
  generatedFiles: z.array(z.string()),
  errors: z.array(z.string()),
});
export type WangpGenerationSettings = z.infer<typeof wangpGenerationSettingsSchema>;
