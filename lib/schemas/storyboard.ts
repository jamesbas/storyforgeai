import { z } from "zod";
import { SCENE_STATUSES } from "@/lib/types";
import { creativeBriefSchema, visualBibleSchema } from "@/lib/schemas/agents";
import { projectSchema } from "@/lib/schemas/project";
import { dialogueLineSchema, audioPlanSchema, animaticPlanSchema } from "@/lib/schemas/audio";
import { sceneAttemptSchema } from "@/lib/schemas/generation";
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
  videoPrompt20s: z.string(),
  videoNegativePrompt: z.string(),
  promptQualityChecklist: z.array(z.string()),
});
export type ScenePrompts = z.infer<typeof scenePromptsSchema>;

export const sceneSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sceneNumber: z.number().int().positive(),
  startTimeSeconds: z.number().int().nonnegative(),
  endTimeSeconds: z.number().int().positive(),
  targetDurationSeconds: z.literal(20),
  trimAtEndSeconds: z.number().int().positive().optional(),
  title: z.string(),
  sceneObjective: z.string(),
  storyBeat: z.string(),
  visualDescription: z.string(),
  actionDescription: z.string(),
  cameraMovement: z.string(),
  transitionIn: z.string(),
  transitionOut: z.string(),
  continuityNotes: z.array(z.string()),
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
  assembly: assemblySchema.optional(),
  history: z.array(historyEntrySchema).optional(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
