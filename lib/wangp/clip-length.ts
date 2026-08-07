import type { ModelFamily } from "@/lib/wangp/family";
import { MAX_SEGMENT_SECONDS, SEGMENT_SECONDS } from "@/lib/types";

export type ClipLengthGuidance = {
  /** Seeded as the default clip length for a project pinned to this family. */
  recommendedSeconds: number;
  /**
   * Longest clip the model renders in one pass. Past it WanGP splits the job
   * into overlapping sliding windows and stitches them, using fields
   * StoryForge cannot set and cannot observe — so a seam there is neither
   * configurable nor visible, unlike a seam between two scenes.
   */
  singleWindowSeconds: number;
  /**
   * A frame count the model cannot exceed at all, as opposed to one past which
   * it stitches. Only set where the variant has no sliding-window support, so
   * there is no longer clip to be had at any quality.
   */
  maxFrames?: number;
};

/**
 * Per-family clip-length advice.
 *
 * Advice, not a limit — except where `maxFrames` says otherwise. Every model
 * here will render longer than `singleWindowSeconds`. The numbers exist so the
 * operator is choosing rather than discovering.
 *
 * MiniMax H3's FL2VA variants report `sliding_window_size: 362` at a native
 * 24fps, which is 15.1s — so StoryForge's own 20s default already crosses it.
 * 15s is recommended to sit just inside.
 *
 * Ref2VA is the exception, and the reason `maxFrames` exists: Wan2GP's own
 * documentation states it supports no sliding windows, so its 337-frame ceiling
 * is where the clip stops rather than where stitching begins. At 24fps that is
 * 14.04s, and 14 is recommended to land inside it after 8-frame alignment.
 */
const GUIDANCE: Partial<Record<ModelFamily, ClipLengthGuidance>> = {
  minimax: { recommendedSeconds: 15, singleWindowSeconds: 15 },
  minimax_ref2va: { recommendedSeconds: 14, singleWindowSeconds: 14, maxFrames: 337 },
};

export function clipLengthGuidance(family: ModelFamily): ClipLengthGuidance | undefined {
  return GUIDANCE[family];
}

/** The clip length to offer for a family, within the range the schema allows. */
export function recommendedSegmentSeconds(family: ModelFamily): number {
  const seconds = clipLengthGuidance(family)?.recommendedSeconds ?? SEGMENT_SECONDS;
  return Math.min(seconds, MAX_SEGMENT_SECONDS);
}
