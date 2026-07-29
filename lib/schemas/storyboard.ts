import { z } from "zod";
import { MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, SCENE_STATUSES } from "@/lib/types";
import { creativeBriefSchema, visualBibleSchema } from "@/lib/schemas/agents";
import { projectSchema } from "@/lib/schemas/project";
import { dialogueLineSchema, audioPlanSchema, animaticPlanSchema } from "@/lib/schemas/audio";
import { sceneAttemptSchema, scenePreviewSchema } from "@/lib/schemas/generation";
import { assemblySchema } from "@/lib/schemas/assembly";
import {
  artDirectionPlanSchema,
  cinematographyPlanSchema,
  creativeVariantSchema,
  directorialPlanSchema,
  historyEntrySchema,
  worldBibleSchema,
} from "@/lib/schemas/canvas";

export const sceneStatusSchema = z.enum(SCENE_STATUSES);

export const scenePromptsSchema = z.object({
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
  imageNegativePrompt: z.string(),
  /**
   * Prompt for the clip. Named for the segment rather than a fixed length:
   * segment duration is configurable, and telling the model "20s" when the
   * project renders 8s clips makes it write far too much action into the shot.
   */
  videoPromptSegment: z.string(),
  videoNegativePrompt: z.string(),
  /** Advisory review notes; defaulted for the same reason as continuityNotes. */
  promptQualityChecklist: z.array(z.string()).default([]),
});
export type ScenePrompts = z.infer<typeof scenePromptsSchema>;

/**
 * Hand edits to a scene's prompts.
 *
 * Every field is optional so a caller can correct one line without resending the
 * rest. The quality checklist is deliberately excluded: it is the prompt agent's
 * own review notes, not an input to generation.
 */
export const scenePromptsPatchSchema = z
  .object({
    startFramePrompt: z.string().max(8000),
    endFramePrompt: z.string().max(8000),
    imageNegativePrompt: z.string().max(4000),
    videoPromptSegment: z.string().max(8000),
    videoNegativePrompt: z.string().max(4000),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Provide at least one prompt field to update.",
  });
export type ScenePromptsPatch = z.infer<typeof scenePromptsPatchSchema>;

export const sceneSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sceneNumber: z.number().int().positive(),
  startTimeSeconds: z.number().int().nonnegative(),
  endTimeSeconds: z.number().int().positive(),
  targetDurationSeconds: z.number().int().min(MIN_SEGMENT_SECONDS).max(MAX_SEGMENT_SECONDS),
  trimAtEndSeconds: z.number().int().positive().optional(),
  title: z.string(),
  sceneObjective: z.string(),
  storyBeat: z.string(),
  visualDescription: z.string(),
  actionDescription: z.string(),
  cameraMovement: z.string(),
  transitionIn: z.string(),
  transitionOut: z.string(),
  /**
   * Defaulted rather than required: a model that wrote fifteen good scenes but
   * omitted this on three of them had the whole storyboard rejected, costing a
   * full replanning pass. The notes are advisory, so an empty list is a fair
   * reading of "nothing to carry".
   */
  continuityNotes: z.array(z.string()).default([]),
  narrationText: z.string().optional(),
  dialogue: z.array(dialogueLineSchema).optional(),
  musicNotes: z.string().optional(),
  sfxNotes: z.string().optional(),
  status: sceneStatusSchema,
  prompts: scenePromptsSchema,
});
export type Scene = z.infer<typeof sceneSchema>;

/**
 * A scene before prompt agents attach image/video prompts. The Storyboard Agent
 * emits drafts; the Image/Video Prompt Agents complete them (spec Section 8.1).
 */
export const sceneDraftSchema = sceneSchema.omit({ prompts: true });
export type SceneDraft = z.infer<typeof sceneDraftSchema>;

export const storyboardSnapshotSchema = z.object({
  brief: creativeBriefSchema,
  visualBible: visualBibleSchema,
  scenes: z.array(sceneSchema),
});
export type StoryboardSnapshot = z.infer<typeof storyboardSnapshotSchema>;

export const projectRecordSchema = z.object({
  project: projectSchema,
  variants: z.array(creativeVariantSchema).optional(),
  selectedVariantId: z.string().optional(),
  worldBible: worldBibleSchema.optional(),
  directorialPlan: directorialPlanSchema.optional(),
  cinematographyPlan: cinematographyPlanSchema.optional(),
  artDirectionPlan: artDirectionPlanSchema.optional(),
  storyboard: storyboardSnapshotSchema.optional(),
  audioPlan: audioPlanSchema.optional(),
  animaticPlan: animaticPlanSchema.optional(),
  attempts: z.record(z.array(sceneAttemptSchema)).optional(),
  /** One-off keyframe renders, keyed by scene id. Never assembled. */
  previews: z.record(scenePreviewSchema).optional(),
  assembly: assemblySchema.optional(),
  history: z.array(historyEntrySchema).optional(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
