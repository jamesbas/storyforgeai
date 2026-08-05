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
};

/**
 * Per-family clip-length advice.
 *
 * Advice, not a limit: every model here will render longer than
 * `singleWindowSeconds`. The numbers exist so the operator is choosing rather
 * than discovering.
 *
 * MiniMax H3 reports `sliding_window_size: 481` at a native 24fps, which is
 * 20.04s — exactly where StoryForge's own 20s default lands, with no margin.
 * 15s is recommended to sit clear of that edge.
 */
const GUIDANCE: Partial<Record<ModelFamily, ClipLengthGuidance>> = {
  minimax: { recommendedSeconds: 15, singleWindowSeconds: 20 },
};

export function clipLengthGuidance(family: ModelFamily): ClipLengthGuidance | undefined {
  return GUIDANCE[family];
}

/** The clip length to offer for a family, within the range the schema allows. */
export function recommendedSegmentSeconds(family: ModelFamily): number {
  const seconds = clipLengthGuidance(family)?.recommendedSeconds ?? SEGMENT_SECONDS;
  return Math.min(seconds, MAX_SEGMENT_SECONDS);
}
