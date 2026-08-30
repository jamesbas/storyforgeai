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
 * Advice, not a limit. Every model here will render longer than
 * `singleWindowSeconds`. The numbers exist so the operator is choosing rather
 * than discovering.
 *
 * MiniMax H3 windows at `sliding_window_size: 481`, read from live WanGP
 * v12.647 defaults for both `minimax_h3_fl2va_pruned` and
 * `minimax_h3_ref2va_pruned`. At H3's native 24fps that is 20.04s, and
 * `fps * seconds + 1` puts a 20s clip at exactly 481 frames — so both variants
 * cover this app's whole clip-length range in a single pass.
 *
 * Earlier builds windowed at 362 (15.1s), and Ref2VA was additionally capped
 * near 337 frames. Neither holds now; the numbers here are read from the
 * shipped model defaults rather than carried forward.
 */
const GUIDANCE: Partial<Record<ModelFamily, ClipLengthGuidance>> = {
  minimax: { recommendedSeconds: 20, singleWindowSeconds: 20 },
  minimax_ref2va: { recommendedSeconds: 20, singleWindowSeconds: 20 },
};

export function clipLengthGuidance(family: ModelFamily): ClipLengthGuidance | undefined {
  return GUIDANCE[family];
}

/** The clip length to offer for a family, within the range the schema allows. */
export function recommendedSegmentSeconds(family: ModelFamily): number {
  const seconds = clipLengthGuidance(family)?.recommendedSeconds ?? SEGMENT_SECONDS;
  return Math.min(seconds, MAX_SEGMENT_SECONDS);
}
