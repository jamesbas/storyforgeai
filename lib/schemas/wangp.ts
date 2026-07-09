import { z } from "zod";

/** WanGP model as returned by MCP discovery (spec Section 5.2 / 11.3). */
export const wangpModelSchema = z.object({
  modelType: z.string(),
  name: z.string(),
  metadata: z.object({
    mainOutput: z.enum(["image", "video", "audio"]),
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
      })
      .optional(),
    supportsLora: z.boolean().optional(),
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
