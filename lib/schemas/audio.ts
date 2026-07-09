import { z } from "zod";

/** Dialogue line used in scenes and audio cues (spec Section 6.4 / 2A.7). */
export const dialogueLineSchema = z.object({
  character: z.string(),
  line: z.string(),
});
export type DialogueLine = z.infer<typeof dialogueLineSchema>;

export const voiceProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["narrator", "character", "host", "announcer"]),
  voiceDescription: z.string(),
  accent: z.string().optional(),
  pacing: z.string().optional(),
  emotion: z.string().optional(),
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const sceneAudioCueSchema = z.object({
  sceneId: z.string(),
  narrationText: z.string().optional(),
  dialogueLines: z.array(dialogueLineSchema).optional(),
  musicCue: z.string().optional(),
  sfxCues: z.array(z.string()).optional(),
  lipSyncRequired: z.boolean(),
});
export type SceneAudioCue = z.infer<typeof sceneAudioCueSchema>;

/** Project-level audio plan (spec Section 2A.7). */
export const audioPlanSchema = z.object({
  projectId: z.string(),
  narrationRequired: z.boolean(),
  dialogueRequired: z.boolean(),
  musicRequired: z.boolean(),
  sfxRequired: z.boolean(),
  voiceProfiles: z.array(voiceProfileSchema),
  sceneAudioCues: z.array(sceneAudioCueSchema),
  musicDirection: z.string().optional(),
  sfxLibraryNotes: z.string().optional(),
});
export type AudioPlan = z.infer<typeof audioPlanSchema>;

/** Animatic frame + plan (spec Section 2A.5 / 14.7). */
export const animaticFrameSchema = z.object({
  sceneNumber: z.number().int().positive(),
  caption: z.string(),
  durationSeconds: z.number().int().positive(),
  transitionIn: z.string(),
  transitionOut: z.string(),
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
});
export type AnimaticFrame = z.infer<typeof animaticFrameSchema>;

export const animaticPlanSchema = z.object({
  projectId: z.string(),
  totalDurationSeconds: z.number().int().nonnegative(),
  frames: z.array(animaticFrameSchema),
  sceneDurationMap: z.record(z.number()),
  previewAssembled: z.boolean(),
  previewPath: z.string().optional(),
});
export type AnimaticPlan = z.infer<typeof animaticPlanSchema>;
