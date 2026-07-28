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

/**
 * A one-off keyframe render, kept deliberately outside `attempts`.
 *
 * Iterating on a prompt should not cost a full scene — two images and a video is
 * minutes of GPU time to judge a change visible in a single still. But a partial
 * attempt would be worse than useless: media listing and assembly both take the
 * newest attempt for a scene, so a keyframe-only entry would mask a finished
 * clip. Previews therefore live in their own map, are never approved, and are
 * never assembled.
 */
export const scenePreviewSchema = z.object({
  startFramePath: z.string().optional(),
  endFramePath: z.string().optional(),
  updatedAt: z.string(),
});
export type ScenePreview = z.infer<typeof scenePreviewSchema>;
