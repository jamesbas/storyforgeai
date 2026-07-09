import { z } from "zod";

/** QC result (spec Section 16). */
export const qcResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  severity: z.enum(["none", "minor", "major", "critical"]),
  issues: z.array(z.string()),
  matchedRequirements: z.array(z.string()),
  regenerationInstructions: z.string().optional(),
});
export type QCResult = z.infer<typeof qcResultSchema>;

/** A single generation attempt for a scene (spec Section 6.7). */
export const sceneAttemptSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  attemptNumber: z.number().int().positive(),
  startImagePath: z.string().optional(),
  endImagePath: z.string().optional(),
  videoPath: z.string().optional(),
  audioPath: z.string().optional(),
  settingsIds: z.array(z.string()),
  qcResult: qcResultSchema.optional(),
  approved: z.boolean(),
  createdAt: z.string(),
});
export type SceneAttempt = z.infer<typeof sceneAttemptSchema>;
