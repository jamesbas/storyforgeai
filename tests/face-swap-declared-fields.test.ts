import { describe, expect, it } from "vitest";

import { QWEN_FACE_SWAP_SETTINGS, faceSwapSettingsFor } from "@/lib/wangp/face-swap-preset";
import type { WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Face swap is the one generation path that does not go through
 * `buildSettingsManifest`, which is the thing that keeps every other request to
 * fields the selected model publishes. The preset was spread over the defaults
 * whole, so it could hand a checkpoint a control it has never heard of.
 *
 * Live on server 1.10.1: `qwen_image_edit_plus2_20B` publishes neither a
 * declaration nor a default for `image_mode`, and `krea2_turbo_edit` publishes
 * no `guidance_scale` at all — a sibling application reports a schema error for
 * exactly that field on exactly that checkpoint.
 */
function schema(fields: string[], defaults: Record<string, unknown>): WangpModelSchema {
  return {
    modelType: "m",
    defaultSettings: defaults,
    fields: fields.map((name) => ({ name, type: "string" })),
  } as WangpModelSchema;
}

const FACE_SWAP_LORAS_SETTING = QWEN_FACE_SWAP_SETTINGS.activated_loras;

describe("sending a face-swap preset to a model that may not have the fields", () => {
  it("keeps a field the model declares", () => {
    const settings = faceSwapSettingsFor(schema(["guidance_scale"], {}), QWEN_FACE_SWAP_SETTINGS);
    expect(settings.guidance_scale).toBe(QWEN_FACE_SWAP_SETTINGS.guidance_scale);
  });

  it("keeps a field the model publishes only as a default", () => {
    // `model_mode` and `masking_strength` are real controls on the swap model
    // that never appear in its declared field list.
    const settings = faceSwapSettingsFor(
      schema([], { model_mode: 0, masking_strength: 1 }),
      QWEN_FACE_SWAP_SETTINGS,
    );
    expect(settings.model_mode).toBe(QWEN_FACE_SWAP_SETTINGS.model_mode);
    expect(settings.masking_strength).toBe(QWEN_FACE_SWAP_SETTINGS.masking_strength);
  });

  it("drops a field the model has never heard of", () => {
    const settings = faceSwapSettingsFor(
      schema(["prompt"], { prompt: "" }),
      QWEN_FACE_SWAP_SETTINGS,
    );
    expect(settings).not.toHaveProperty("mask_expand");
  });

  it("does not send guidance to a distilled checkpoint that has none", () => {
    // krea2_turbo_edit: CFG is disabled and the field is simply absent. A
    // fallback value is not neutral here, it is a schema error.
    const krea = schema(
      ["prompt", "negative_prompt", "resolution", "num_inference_steps", "activated_loras"],
      { prompt: "", resolution: "1024x1024", num_inference_steps: 8, activated_loras: [] },
    );
    const settings = faceSwapSettingsFor(krea, QWEN_FACE_SWAP_SETTINGS);
    expect(settings).not.toHaveProperty("guidance_scale");
    expect(settings).not.toHaveProperty("guidance_phases");
    expect(settings).not.toHaveProperty("mask_expand");
  });

  it("still carries the LoRA stack the preset depends on", () => {
    // Dropping these would leave a 4-step, CFG-1 job running without the
    // schedule those numbers assume — worse than erroring.
    const settings = faceSwapSettingsFor(
      schema(["activated_loras", "loras_multipliers", "num_inference_steps"], {}),
      QWEN_FACE_SWAP_SETTINGS,
    );
    expect(settings.activated_loras).toEqual(FACE_SWAP_LORAS_SETTING);
    expect(settings.loras_multipliers).toBe(QWEN_FACE_SWAP_SETTINGS.loras_multipliers);
    expect(settings.num_inference_steps).toBe(QWEN_FACE_SWAP_SETTINGS.num_inference_steps);
  });
});

/**
 * The mask-tuning pair, which the two Qwen edit checkpoints disagree about.
 *
 * The preset supplies a reference face rather than an inpainting mask, so these
 * are refinements rather than requirements — sending one to a checkpoint that
 * does not publish it buys nothing and risks a schema rejection.
 */
describe("mask settings across the two Qwen edit checkpoints", () => {
  it("keeps masking_strength where the checkpoint publishes it, and drops mask_expand", () => {
    // qwen_image_edit_plus2_20B, live: `masking_strength` appears among the
    // defaults, `mask_expand` in neither the declarations nor the defaults.
    const plus2 = schema(
      ["prompt", "guidance_scale", "sample_solver", "activated_loras", "loras_multipliers"],
      { prompt: "", model_mode: 0, masking_strength: 1, guidance_phases: 1 },
    );
    const settings = faceSwapSettingsFor(plus2, QWEN_FACE_SWAP_SETTINGS);

    expect(settings.masking_strength).toBe(QWEN_FACE_SWAP_SETTINGS.masking_strength);
    expect(settings).not.toHaveProperty("mask_expand");
  });

  it("drops both where the checkpoint publishes neither", () => {
    // qwen_image_edit_20B, which still publishes the solver, guidance and LoRA
    // settings the preset actually depends on.
    const older = schema(
      ["prompt", "guidance_scale", "sample_solver", "activated_loras", "loras_multipliers"],
      { prompt: "", model_mode: 0, guidance_phases: 1 },
    );
    const settings = faceSwapSettingsFor(older, QWEN_FACE_SWAP_SETTINGS);

    expect(settings).not.toHaveProperty("masking_strength");
    expect(settings).not.toHaveProperty("mask_expand");
    expect(settings.sample_solver).toBe(QWEN_FACE_SWAP_SETTINGS.sample_solver);
    expect(settings.guidance_scale).toBe(QWEN_FACE_SWAP_SETTINGS.guidance_scale);
    expect(settings.model_mode).toBe(QWEN_FACE_SWAP_SETTINGS.model_mode);
    expect(settings.activated_loras).toEqual(FACE_SWAP_LORAS_SETTING);
  });
});
