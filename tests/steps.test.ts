import { describe, it, expect } from "vitest";
import { resolveSteps } from "@/lib/wangp/steps";
import type { LoraSelection } from "@/lib/schemas/lora";

/**
 * Denoising step counts.
 *
 * WanGP reports saved UI state as a model's defaults. `qwen_image_edit_plus2_20B`
 * came back with `num_inference_steps: 4`, `guidance_scale: 1` and a Lightning
 * accelerator LoRA already attached — tuned as a set. StoryForgeAI writes
 * `activated_loras` on every job, so the accelerator was stripped and the four
 * steps survived, and every keyframe came back a smear.
 */

const lora = (name: string): LoraSelection => ({ name, strength: 1 });
const FLOOR = 30;

describe("when nothing is accelerating the model", () => {
  /** The exact case that produced the smeared frames. */
  it("raises a Lightning-tuned default to the floor", () => {
    expect(
      resolveSteps({
        modelType: "qwen_image_edit_plus2_20B",
        modelDefault: 4,
        loras: [],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 30, reason: "floor" });
  });

  /** A model asking for more than the floor knows better than the floor does. */
  it("leaves a higher default alone", () => {
    expect(
      resolveSteps({
        modelType: "flux2_klein_base_9b",
        modelDefault: 50,
        loras: [],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 50, reason: "model_default" });
  });

  it("uses the floor when the model declares no step count", () => {
    expect(
      resolveSteps({
        modelType: "some_model",
        modelDefault: undefined,
        loras: [],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 30, reason: "floor" });
  });
});

describe("when something is accelerating the model", () => {
  /** An 8-step LoRA run at 4 is half-denoised; run at 30 it is over-cooked. */
  it("takes the step count named in the LoRA's filename", () => {
    expect(
      resolveSteps({
        modelType: "qwen_image_edit_plus2_20B",
        modelDefault: 4,
        loras: [lora("Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors")],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 8, reason: "lora_step_hint" });
  });

  it("reads other spellings of the hint", () => {
    for (const [name, steps] of [
      ["model-lightning-4step.safetensors", 4],
      ["Hyper-SD-12_steps.safetensors", 12],
      ["lcm-lora-6 steps.safetensors", 6],
    ] as const) {
      expect(
        resolveSteps({
          modelType: "m",
          modelDefault: 4,
          loras: [lora(name)],
          override: undefined,
          floor: FLOOR,
        }),
      ).toEqual({ steps, reason: "lora_step_hint" });
    }
  });

  /** No readable count, but the stack is clearly tuned — do not raise it. */
  it("leaves the model default alone for an unlabelled accelerator", () => {
    expect(
      resolveSteps({
        modelType: "qwen_image_edit_plus2_20B",
        modelDefault: 4,
        loras: [lora("qwen-turbo-accelerator.safetensors")],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 4, reason: "accelerated" });
  });

  /**
   * A distilled model needs no LoRA to be fast. Raising LTX-2 distilled from 8
   * to 30 would quadruple every clip for no gain.
   */
  it("leaves a distilled model alone", () => {
    expect(
      resolveSteps({
        modelType: "ltx2_22B_distilled_1_1",
        modelDefault: 8,
        loras: [],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 8, reason: "accelerated" });
  });

  /** A non-accelerator LoRA in the stack must not suppress the floor. */
  it("ignores an ordinary LoRA", () => {
    expect(
      resolveSteps({
        modelType: "qwen_image_edit_plus2_20B",
        modelDefault: 4,
        loras: [lora("Qwen_Snofs_1_3.safetensors")],
        override: undefined,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 30, reason: "floor" });
  });
});

describe("the project override", () => {
  it("wins over everything else", () => {
    expect(
      resolveSteps({
        modelType: "ltx2_22B_distilled_1_1",
        modelDefault: 8,
        loras: [lora("lightning-8steps.safetensors")],
        override: 12,
        floor: FLOOR,
      }),
    ).toEqual({ steps: 12, reason: "project_override" });
  });
});
