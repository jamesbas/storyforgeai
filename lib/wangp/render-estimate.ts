/**
 * How long a clip takes, in minutes, on each MiniMax H3 variant.
 *
 * Derived from live runs rather than guessed, because the number exists to stop
 * someone starting a nine-scene batch that will take four hours without knowing
 * it. Measured at 832x480 / 328 frames on the machine named in
 * `ESTIMATE_HARDWARE`, which is why that string is shown wherever these numbers
 * are: they are one workstation's figures, and the ratios between them travel
 * better than the absolute values do.
 *
 * Ref2VA's cost is per *reference*, not per pixel: downscaling an identity
 * photograph by roughly 8x in area changed a 28:59 render to 28:56. Everything
 * shares one packed multimodal sequence, and each image lengthens it.
 */

/** The workstation every figure here was measured on. */
export const ESTIMATE_HARDWARE =
  "Intel Core 9, 64 GB RAM, RTX 5070 Ti 16 GB";

/** Fixed cost before any reference is encoded. */
const REF2VA_BASE_MINUTES = 8;

/** Marginal cost of one reference image. */
const REF2VA_PER_REFERENCE_MINUTES = 7;

/** The start and end frames, which every reference-mode clip carries. */
const REF2VA_ANCHORS = 2;

/**
 * Spectrum step skipping, measured at 20 steps: 28:56 → 20:00.
 *
 * Chosen per model in the WanGP UI rather than here, and inherited from that
 * model's saved settings, so a project renders with whatever WanGP is
 * configured for. Not assumed in the estimate below, which quotes the
 * un-accelerated figure.
 */
const SPECTRUM_FACTOR = 0.69;

/**
 * FL2VA at 20 steps, un-accelerated.
 *
 * The 4-step turbo LoRA takes this to about 6 minutes, but that is a per-scene
 * LoRA choice rather than a property of the tier, so the conservative figure is
 * the one shown.
 */
export const FL2VA_ESTIMATE_MINUTES = 17;

export function ref2vaEstimateMinutes(characters: number): number {
  const references = REF2VA_ANCHORS + Math.max(0, characters);
  return REF2VA_BASE_MINUTES + references * REF2VA_PER_REFERENCE_MINUTES;
}

/** What the same clip would cost with Spectrum enabled in the WanGP UI. */
export function ref2vaAcceleratedMinutes(characters: number): number {
  return Math.round(ref2vaEstimateMinutes(characters) * SPECTRUM_FACTOR);
}
