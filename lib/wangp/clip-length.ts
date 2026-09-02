import type { ModelFamily } from "@/lib/wangp/family";
import { MAX_SEGMENT_SECONDS, SEGMENT_SECONDS } from "@/lib/types";

export type ClipLengthGuidance = {
  /** Seeded as the default clip length for a project pinned to this family. */
  recommendedSeconds: number;
  /** WanGP window size StoryForge must send instead of inheriting saved UI state. */
  slidingWindowFrames: number;
  /**
   * Longest clip the model renders in one pass. Past it WanGP splits the job
    * into overlapping sliding windows and stitches them. StoryForge fixes the
    * window size but does not expose the model-specific overlap and trim fields.
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
 * MiniMax H3 must window at `sliding_window_size: 481`. At H3's native 24fps
 * that is 20.04s, and `fps * seconds + 1` puts a 20s clip at exactly 481
 * frames, so both variants cover this app's whole clip-length range in one
 * pass.
 *
 * WanGP defaults differ by checkpoint. Live v12.647 defaults for the pruned
 * FL2VA and Ref2VA checkpoints carried 481, while the PDD checkpoint carried
 * 362 and stopped a 481-frame request after 15.08s. The manifest therefore
 * sends this value explicitly instead of inheriting mutable WanGP UI state.
 */
const GUIDANCE: Partial<Record<ModelFamily, ClipLengthGuidance>> = {
  minimax: { recommendedSeconds: 20, slidingWindowFrames: 481, singleWindowSeconds: 20 },
  minimax_ref2va: { recommendedSeconds: 20, slidingWindowFrames: 481, singleWindowSeconds: 20 },
};

export function clipLengthGuidance(family: ModelFamily): ClipLengthGuidance | undefined {
  return GUIDANCE[family];
}

/** The clip length to offer for a family, within the range the schema allows. */
export function recommendedSegmentSeconds(family: ModelFamily): number {
  const seconds = clipLengthGuidance(family)?.recommendedSeconds ?? SEGMENT_SECONDS;
  return Math.min(seconds, MAX_SEGMENT_SECONDS);
}
