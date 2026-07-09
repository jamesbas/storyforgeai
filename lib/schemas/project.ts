import { z } from "zod";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MODEL_STRATEGIES,
  PROJECT_STATUSES,
  RESOLUTION_PRESETS,
} from "@/lib/types";

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  concept: z.string(),
  requestedDurationSeconds: z.number().int().positive(),
  segmentSeconds: z.literal(20),
  segmentCount: z.number().int().positive(),
  generatedDurationSeconds: z.number().int().nonnegative(),
  finalTrimSeconds: z.number().int().nonnegative(),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolutionPreset: z.enum(RESOLUTION_PRESETS),
  style: z.string(),
  tone: z.string(),
  audience: z.string().optional(),
  creativeMode: z.enum(CREATIVE_MODES),
  narrationRequired: z.boolean(),
  dialogueRequired: z.boolean(),
  musicRequired: z.boolean(),
  sfxRequired: z.boolean(),
  generationMode: z.enum(GENERATION_MODES),
  modelStrategy: z.enum(MODEL_STRATEGIES),
  status: projectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof projectSchema>;
