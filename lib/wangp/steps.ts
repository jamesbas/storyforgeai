import type { LoraSelection } from "@/lib/schemas/lora";

/**
 * How many denoising steps a job should run.
 *
 * WanGP reports `num_inference_steps` in a model's default settings, but those
 * defaults are *saved UI state* rather than the model's intrinsic setting. A
 * model last used in the WanGP UI with a Lightning accelerator LoRA comes back
 * reporting four steps and a guidance scale of one, tuned to that LoRA — and
 * StoryForge overwrites `activated_loras` on every job, so the accelerator is
 * stripped while its step count survives. Four steps with no accelerator is how
 * a keyframe comes back looking like a smeared underexposure.
 *
 * The rule is therefore: trust the model's number only when something is
 * actually accelerating it, and otherwise hold a floor.
 */

/**
 * Names that mean "this is distilled or accelerated", in a model type or a LoRA
 * filename. Matched case-insensitively against both.
 */
const ACCELERATOR_PATTERNS = [
  "lightning",
  "lightx2v",
  "distill",
  "turbo",
  "schnell",
  "accelerat",
  "hyper",
  "lcm",
];

/**
 * A step count written into a LoRA's filename — `Lightning-8steps`, `4-step`,
 * `8_steps`. Authors put it there because the LoRA only works at that count.
 *
 * The trailing guard is "not followed by a letter" rather than `\b`, because
 * `_` is a word character: `\b` matched `Lightning-8steps.safetensors` but not
 * `minimax_h3_turbo_4step_ckpt500.safetensors`, and missing the hint runs a
 * 4-step LoRA at the model's 20 — five times the wait for a burnt frame.
 */
const STEP_HINT = /(\d{1,2})[\s_-]*steps?(?![a-z])/i;

const isAccelerator = (name: string): boolean => {
  const lower = name.toLocaleLowerCase();
  return ACCELERATOR_PATTERNS.some((pattern) => lower.includes(pattern));
};

export type StepResolution = {
  steps: number;
  /** Why, for logging — a silent change to step count is impossible to debug. */
  reason: "project_override" | "lora_step_hint" | "accelerated" | "floor" | "model_default";
};

/**
 * Resolve the step count for one job.
 *
 * Precedence:
 *  1. An explicit per-project value. The user has decided; nothing overrides it.
 *  2. A step count named in an accelerator LoRA's filename. An 8-step Lightning
 *     LoRA run at 4 steps is half-denoised, and at 30 it is over-cooked.
 *  3. An accelerator with no readable count, or a model that is itself
 *     distilled — leave the model's own number alone, since it was tuned for it.
 *  4. Otherwise a floor, because the model's number may be leftover UI state
 *     from a run that *did* have an accelerator.
 */
export function resolveSteps(args: {
  modelType: string;
  /** `num_inference_steps` from the model's default settings, if it has one. */
  modelDefault: number | undefined;
  loras: readonly LoraSelection[];
  /** Per-project override. Undefined means "decide for me". */
  override: number | undefined;
  floor: number;
}): StepResolution | undefined {
  if (args.override !== undefined) return { steps: args.override, reason: "project_override" };

  const acceleratorLoras = args.loras.filter((lora) => isAccelerator(lora.name));

  for (const lora of acceleratorLoras) {
    const hint = STEP_HINT.exec(lora.name);
    const steps = hint ? Number(hint[1]) : Number.NaN;
    if (Number.isFinite(steps) && steps > 0) return { steps, reason: "lora_step_hint" };
  }

  // A distilled model needs no LoRA to be fast; raising it would be wrong.
  if (acceleratorLoras.length > 0 || isAccelerator(args.modelType)) {
    return args.modelDefault === undefined
      ? undefined
      : { steps: args.modelDefault, reason: "accelerated" };
  }

  if (args.modelDefault === undefined) return { steps: args.floor, reason: "floor" };
  return args.modelDefault < args.floor
    ? { steps: args.floor, reason: "floor" }
    : { steps: args.modelDefault, reason: "model_default" };
}
