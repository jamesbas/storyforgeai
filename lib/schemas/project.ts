import { z } from "zod";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
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
  segmentSeconds: z.number().int().min(MIN_SEGMENT_SECONDS).max(MAX_SEGMENT_SECONDS),
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
  /**
   * Per-project WanGP model pins. When unset the env-level pin
   * (WANGP_IMAGE_MODEL / WANGP_VIDEO_MODEL) applies, and failing that the
   * router picks automatically from `modelStrategy`.
   */
  imageModel: z.string().optional(),
  videoModel: z.string().optional(),
  /**
   * Opt-in to the global character library. When true, `characterIds` names the
   * cast whose locked descriptions are threaded through planning and into every
   * image and video prompt.
   *
   * Optional rather than defaulted so projects created before the library
   * existed still parse.
   */
  useCharacterLibrary: z.boolean().optional(),
  characterIds: z.array(z.string()).optional(),
  status: projectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof projectSchema>;
