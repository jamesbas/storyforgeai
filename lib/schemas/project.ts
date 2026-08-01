import { z } from "zod";
import { loraSelectionSetSchema, sceneLoraMapSchema } from "@/lib/schemas/lora";
import { sceneWardrobeChangesSchema } from "@/lib/schemas/wardrobe";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  MODEL_STRATEGIES,
  PROJECT_STATUSES,
  RESOLUTION_PRESETS,
  SCENE_CONTINUITY_MODES,
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
   * Denoising steps per pinned model. Absent means the count is derived from
   * the model and its LoRA stack — see `resolveSteps`. Set one only to overrule
   * that, because a wrong step count is the difference between a clean frame
   * and a smear.
   */
  imageSteps: z.number().int().min(1).max(200).optional(),
  videoSteps: z.number().int().min(1).max(200).optional(),
  /**
   * Whether the QC agent grades finished scenes. Absent means off: it is a full
   * LLM round-trip per scene on the same GPU that just rendered them, and it
   * cannot see anything unless a vision model is configured.
   */
  qcEnabled: z.boolean().optional(),
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
  /**
   * Whether a pinned character's reference photograph conditions the keyframe.
   *
   * A photograph is the strongest identity signal available, and it conditions
   * the whole image rather than one figure in it: on a shot with several people
   * the model applies the likeness to more than one of them. Turning it off
   * leaves identity to the written description and the face swap, and lifts the
   * constraint that the image model must accept reference images.
   *
   * Optional so projects created before it existed keep the old behaviour.
   */
  useCharacterReferenceImages: z.boolean().optional(),
  /**
   * Filenames under this project's `concept-images` folder.
   *
   * Images that describe the piece rather than a character in it. Read once by
   * the Concept Reader into `conceptVisuals`; the agents read that text.
   */
  conceptImages: z.array(z.string()).max(6).optional(),
  /**
   * Wardrobe for this project, keyed by character id.
   *
   * Costume is a property of the story, not the person: the same character
   * wears different clothes in different projects. This overrides whatever
   * default the library record carries.
   */
  characterWardrobe: z.record(z.string()).optional(),
  /**
   * Costume changes, keyed by the scene at which each takes effect.
   *
   * Absent means the wardrobe above holds for the whole piece, which is what
   * every project did before this existed.
   */
  wardrobeChanges: z.record(sceneWardrobeChangesSchema).optional(),
  /**
   * How each scene connects to the previous one. Optional so projects created
   * before the setting existed still parse; absent means DEFAULT_SCENE_CONTINUITY.
   */
  sceneContinuity: z.enum(SCENE_CONTINUITY_MODES).optional(),
  /**
   * Storyboard-wide LoRA stack, split by the model kind it applies to.
   * Optional so projects created before LoRA support still parse.
   */
  loras: loraSelectionSetSchema.optional(),
  /**
   * Per-scene departures from `loras`, keyed by scene id.
   *
   * Kept beside the scenes rather than on `sceneSchema` because scenes are
   * agent-generated and regenerated wholesale; a user's selection must not be
   * something the Storyboard Agent has to emit or preserve.
   */
  sceneLoras: sceneLoraMapSchema.optional(),
  /**
   * Per-scene image seed, keyed by scene id.
   *
   * Pinned so a keyframe preview predicts the keyframe the scene will actually
   * render: without it the two are independent samples and the preview only
   * ever showed what the prompt *could* produce. Cleared to re-roll.
   */
  sceneSeeds: z.record(z.number().int().nonnegative()).optional(),
  status: projectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof projectSchema>;
