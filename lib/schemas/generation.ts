import { z } from "zod";
import { maybe } from "@/lib/schemas/maybe";

/** QC result (spec Section 16). */
export const qcResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  severity: z.enum(["none", "minor", "major", "critical"]),
  issues: z.array(z.string()),
  matchedRequirements: z.array(z.string()),
  regenerationInstructions: maybe(z.string()),
});
export type QCResult = z.infer<typeof qcResultSchema>;

/** A single generation attempt for a scene (spec Section 6.7). */
export const sceneAttemptSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  attemptNumber: z.number().int().positive(),
  startImagePath: maybe(z.string()),
  endImagePath: maybe(z.string()),
  /**
   * The keyframes as rendered, before any face swap. Kept so a manual swap
   * works from the original rather than stacking a second pass on the first,
   * and so a swap can be undone. Absent when nothing was swapped.
   */
  startImageSourcePath: maybe(z.string()),
  endImageSourcePath: maybe(z.string()),
  /**
   * The start frame is the previous scene's end frame, so this scene's own
   * start-frame prompt was never rendered. Recorded because the Prompts panel
   * would otherwise show text that had no effect on the image.
   */
  startImageInherited: maybe(z.boolean()),
  videoPath: maybe(z.string()),
  audioPath: maybe(z.string()),
  settingsIds: z.array(z.string()),
  qcResult: maybe(qcResultSchema),
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
  startFramePath: maybe(z.string()),
  endFramePath: maybe(z.string()),
  updatedAt: z.string(),
});
export type ScenePreview = z.infer<typeof scenePreviewSchema>;
