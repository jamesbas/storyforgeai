import { z } from "zod";
import { loraSelectionSetSchema, sceneLoraMapSchema } from "@/lib/schemas/lora";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  DEFAULT_SCENE_CONTINUITY,
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
  generationMode: z.enum(GENERATION_MODES).default("video_segments"),
  /** Grade finished scenes with the QC agent. Off unless asked for. */
  qcEnabled: z.boolean().default(false),
  modelStrategy: z.enum(MODEL_STRATEGIES).default("auto"),
  imageModel: z.string().optional(),
  videoModel: z.string().optional(),
  /** Reuse saved character descriptions for this project's cast. */
  useCharacterLibrary: z.boolean().default(false),
  characterIds: z.array(z.string()).default([]),
  /** Per-character wardrobe for this project, keyed by character id. */
  characterWardrobe: z.record(z.string()).default({}),
  /** How each scene joins the previous one. See DEFAULT_SCENE_CONTINUITY. */
  sceneContinuity: z.enum(SCENE_CONTINUITY_MODES).default(DEFAULT_SCENE_CONTINUITY),
});

/**
 * Input for the concept helper on the New Project form.
 *
 * The settings beside the concept travel with it because a rewrite that ignores
 * the running time or the tone reads as someone else's idea — a 30-second piece
 * described as a three-act story is worse than the sentence it replaced.
 */
export const enhanceConceptSchema = z.object({
  concept: z.string().min(1, "concept is required").max(5000),
  requestedDurationSeconds: z.number().int().positive().max(3600),
  style: z.string().min(1).default("cinematic"),
  tone: z.string().min(1).default("neutral"),
  audience: z.string().optional(),
  creativeMode: z.enum(CREATIVE_MODES).default("film_short"),
});

export type EnhanceConceptInput = z.infer<typeof enhanceConceptSchema>;

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
   * How far the pipeline is allowed to run. Editable because the answer changes
   * as a project matures — you plan first, then decide to render.
   */
  generationMode: z.enum(GENERATION_MODES).optional(),
  /**
   * Denoising steps, per pinned model. Undefined means "decide from the model
   * and its LoRA stack" — see `resolveSteps`.
   */
  imageSteps: z.number().int().min(1).max(200).nullable().optional(),
  videoSteps: z.number().int().min(1).max(200).nullable().optional(),
  /**
   * Frame quality. Editable because it is the usual draft-then-final dial:
   * rough out a storyboard cheaply, then re-render the keepers at high.
   */
  resolutionPreset: z.enum(RESOLUTION_PRESETS).optional(),
  /** Clip frame quality, when it should differ from the keyframes. */
  videoResolutionPreset: z.enum(RESOLUTION_PRESETS).optional(),
  /** Which MiniMax H3 variant clips render on. See `projectSchema.videoTier`. */
  videoTier: z.enum(["fl2va", "ref2va"]).optional(),
  /**
   * Clip length. Editable after creation because the video model is, and a
   * model pinned later can want a different length than the one chosen at
   * intake. Rewrites every existing scene's target duration.
   */
  segmentSeconds: z.number().int().min(MIN_SEGMENT_SECONDS).max(MAX_SEGMENT_SECONDS).optional(),
  /** Whether finished scenes are graded by the QC agent. */
  qcEnabled: z.boolean().optional(),
  /**
   * Continuity affects only scenes generated from here on, so like the model
   * pins it stays editable for the life of the project.
   */
  sceneContinuity: z.enum(SCENE_CONTINUITY_MODES).optional(),
  /** Costume changes between projects, so it stays editable after creation. */
  characterWardrobe: z.record(z.string()).optional(),
  /** Whether a character's reference photograph conditions the keyframes. */
  useCharacterReferenceImages: z.boolean().optional(),
  /**
   * Storyboard-wide LoRA stack. Like the model pins it only affects future
   * generations, so it stays editable for the life of the project.
   */
  loras: loraSelectionSetSchema.optional(),
  /** Per-scene LoRA overrides, keyed by scene id. */
  sceneLoras: sceneLoraMapSchema.optional(),
});

export type UpdateProjectModelsInput = z.infer<typeof updateProjectModelsSchema>;

/** A project's display name. Trimmed, since a title of spaces reads as blank. */
export const renameProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateProjectValues = z.infer<typeof createProjectSchema>;
