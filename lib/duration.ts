import { SEGMENT_SECONDS } from "@/lib/types";

export type Segmentation = {
  segmentSeconds: number;
  segmentCount: number;
  generatedDurationSeconds: number;
  finalTrimSeconds: number;
};

/**
 * Duration-to-segment calculation. All scenes are planned as fixed-length
 * segments (default 20s). See spec Section 2.2.
 */
export function computeSegmentation(
  requestedDurationSeconds: number,
  segmentSeconds: number = SEGMENT_SECONDS,
): Segmentation {
  if (!Number.isFinite(requestedDurationSeconds) || requestedDurationSeconds <= 0) {
    throw new Error("requestedDurationSeconds must be a positive number");
  }
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
    throw new Error("segmentSeconds must be a positive number");
  }

  const segmentCount = Math.ceil(requestedDurationSeconds / segmentSeconds);
  const generatedDurationSeconds = segmentCount * segmentSeconds;
  const finalTrimSeconds = generatedDurationSeconds - requestedDurationSeconds;

  return { segmentSeconds, segmentCount, generatedDurationSeconds, finalTrimSeconds };
}
