import { z } from "zod";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  MODEL_STRATEGIES,
  RESOLUTION_PRESETS,
  SCENE_CONTINUITY_MODES,
  SEGMENT_SECONDS,
} from "@/lib/types";

/**
 * Intake validation for the New Project form and POST /api/projects.
 * Permissive defaults keep the demo path frictionless (spec Section 2.1).
 */
export const createProjectSchema = z.object({
  concept: z.string().min(1, "concept is required").max(5000),
  requestedDurationSeconds: z.number().int().positive().max(3600),
  /** Clip length. Shorter segments mean more scenes for the same runtime. */
  segmentSeconds: z
    .number()
    .int()
    .min(MIN_SEGMENT_SECONDS)
    .max(MAX_SEGMENT_SECONDS)
    .default(SEGMENT_SECONDS),
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
  imageModel: z.string().optional(),
  videoModel: z.string().optional(),
  /** Reuse saved character descriptions for this project's cast. */
  useCharacterLibrary: z.boolean().default(false),
  characterIds: z.array(z.string()).default([]),
  /** Per-character wardrobe for this project, keyed by character id. */
  characterWardrobe: z.record(z.string()).default({}),
  /** How each scene joins the previous one. Defaults to a hard cut. */
  sceneContinuity: z.enum(SCENE_CONTINUITY_MODES).default("cut"),
});

/**
 * Settings that can be changed after creation.
 *
 * Model pins only affect future generations, so they are always safe to edit.
 * `segmentSeconds` is not here: it changes scene boundaries and is handled by
 * its own guarded path in the project service.
 */
export const updateProjectModelsSchema = z.object({
  imageModel: z.string().nullable().optional(),
  videoModel: z.string().nullable().optional(),
  /**
   * Continuity affects only scenes generated from here on, so like the model
   * pins it stays editable for the life of the project.
   */
  sceneContinuity: z.enum(SCENE_CONTINUITY_MODES).optional(),
  /** Costume changes between projects, so it stays editable after creation. */
  characterWardrobe: z.record(z.string()).optional(),
});

export type UpdateProjectModelsInput = z.infer<typeof updateProjectModelsSchema>;

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateProjectValues = z.infer<typeof createProjectSchema>;
