import { z } from "zod";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MODEL_STRATEGIES,
  RESOLUTION_PRESETS,
} from "@/lib/types";

/**
 * Intake validation for the New Project form and POST /api/projects.
 * Permissive defaults keep the demo path frictionless (spec Section 2.1).
 */
export const createProjectSchema = z.object({
  concept: z.string().min(1, "concept is required").max(5000),
  requestedDurationSeconds: z.number().int().positive().max(3600),
  aspectRatio: z.enum(ASPECT_RATIOS).default("16:9"),
  resolutionPreset: z.enum(RESOLUTION_PRESETS).default("standard"),
  style: z.string().min(1).default("cinematic"),
  tone: z.string().min(1).default("neutral"),
  audience: z.string().optional(),
  creativeMode: z.enum(CREATIVE_MODES).default("film_short"),
  narrationRequired: z.boolean().default(false),
  dialogueRequired: z.boolean().default(false),
  musicRequired: z.boolean().default(false),
  sfxRequired: z.boolean().default(false),
  generationMode: z.enum(GENERATION_MODES).default("storyboard_only"),
  modelStrategy: z.enum(MODEL_STRATEGIES).default("auto"),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateProjectValues = z.infer<typeof createProjectSchema>;
