import { describe, expect, it } from "vitest";

import { FACE_SWAP_SETTINGS, faceSwapSettingsFor } from "@/lib/wangp/face-swap-preset";
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

describe("sending a face-swap preset to a model that may not have the fields", () => {
  it("keeps a field the model declares", () => {
    const settings = faceSwapSettingsFor(schema(["guidance_scale"], {}));
    expect(settings.guidance_scale).toBe(FACE_SWAP_SETTINGS.guidance_scale);
  });

  it("keeps a field the model publishes only as a default", () => {
    // `model_mode` and `masking_strength` are real controls on the swap model
    // that never appear in its declared field list.
    const settings = faceSwapSettingsFor(schema([], { model_mode: 0, masking_strength: 1 }));
    expect(settings.model_mode).toBe(FACE_SWAP_SETTINGS.model_mode);
    expect(settings.masking_strength).toBe(FACE_SWAP_SETTINGS.masking_strength);
  });

  it("drops a field the model has never heard of", () => {
    const settings = faceSwapSettingsFor(schema(["prompt"], { prompt: "" }));
    expect(settings).not.toHaveProperty("image_mode");
  });

  it("does not send guidance to a distilled checkpoint that has none", () => {
    // krea2_turbo_edit: CFG is disabled and the field is simply absent. A
    // fallback value is not neutral here, it is a schema error.
    const krea = schema(
      ["prompt", "negative_prompt", "resolution", "num_inference_steps", "activated_loras"],
      { prompt: "", resolution: "1024x1024", num_inference_steps: 8, activated_loras: [] },
    );
    const settings = faceSwapSettingsFor(krea);
    expect(settings).not.toHaveProperty("guidance_scale");
    expect(settings).not.toHaveProperty("guidance_phases");
    expect(settings).not.toHaveProperty("image_mode");
  });

  it("still carries the LoRA stack the preset depends on", () => {
    // Dropping these would leave a 4-step, CFG-1 job running without the
    // schedule those numbers assume — worse than erroring.
    const settings = faceSwapSettingsFor(
      schema(["activated_loras", "loras_multipliers", "num_inference_steps"], {}),
    );
    expect(settings.activated_loras).toEqual(FACE_SWAP_SETTINGS.activated_loras);
    expect(settings.loras_multipliers).toBe(FACE_SWAP_SETTINGS.loras_multipliers);
    expect(settings.num_inference_steps).toBe(FACE_SWAP_SETTINGS.num_inference_steps);
  });
});
