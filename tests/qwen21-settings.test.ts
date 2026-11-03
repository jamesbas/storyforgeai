import { afterEach, describe, expect, it } from "vitest";
import { buildImageManifest } from "@/lib/services/wangp-service";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { isQwen21Model, isStandardQwen21Model } from "@/lib/wangp/qwen21";
import { toWangpSettings } from "@/lib/wangp/mcp/aliases";

function schema(modelType = "qwen_image_21_7B"): WangpModelSchema {
  return {
    modelType,
    defaultSettings: {
      model_type: modelType, prompt: "", resolution: "832x480", num_inference_steps: 40,
      guidance_scale: 4, sample_solver: "pruna", seed: -1,
      custom_settings: { qwen21_kv_cache: "Disabled", rgba: "Enabled", extra_setting: "kept" },
    },
    fields: [
      { name: "prompt", type: "string" },
      { name: "resolution", type: "string" },
      { name: "num_inference_steps", type: "number" },
      { name: "guidance_scale", type: "number", min: 1, max: 20 },
      { name: "sample_solver", type: "string", allowed: ["default", "qwen21_turbo", "viggle_v02", "pruna"] },
      { name: "image_refs", type: "array" },
      { name: "image_guide", type: "string" },
      { name: "video_prompt_type", type: "string" },
    ],
    customSettings: [
      { id: "qwen21_kv_cache", label: "KV Cache", allowed: ["Disabled", "Enabled", "INT8", "INT8_RAM"] },
      { id: "rgba", label: "RGBA", allowed: ["Disabled", "Enabled"] },
    ],
  };
}

class QwenClient extends MockWangpClient {
  readonly calls: Record<string, unknown>[] = [];
  constructor(
    readonly definition = schema(),
    readonly baseModelType?: string,
    readonly advertisedType = definition.modelType,
  ) { super(); }

  async listModels(output?: "image" | "video" | "audio"): Promise<WangpModel[]> {
    const qwen: WangpModel = {
      modelType: this.advertisedType, name: this.advertisedType,
      metadata: {
        mainOutput: "image", inputs: ["text", "image"],
        family: "qwen_image_2", baseModelType: this.baseModelType,
        mediaInputs: { image: { reference: true, multipleReferences: true } },
      },
    };
    return output && output !== "image" ? super.listModels(output) : [qwen, ...await super.listModels(output)];
  }

  async getModelSchema(type: string): Promise<WangpModelSchema> {
    return type === this.definition.modelType ? this.definition : super.getModelSchema(type);
  }

  async generate(settings: Record<string, unknown>) {
    this.calls.push(settings);
    return super.generate(settings);
  }
}

const args = (modelType = "qwen_image_21_7B") => ({
  modelType, modelStrategy: "auto" as const, sceneId: "s1",
  purpose: "start_frame" as const, prompt: "A red teapot on a wooden table.",
});

afterEach(() => setWangpClient(undefined));

describe("Qwen Image 2.1 generation preset", () => {
  it.each(["start_frame", "end_frame"] as const)("sets the requested values on %s and preserves unrelated custom defaults", async (purpose) => {
    const definition = schema();
    const client = new QwenClient(definition);
    setWangpClient(client);
    const manifest = await buildImageManifest({
      ...args(), purpose,
      imageRefs: ["C:\\frames\\carried.png", "C:\\photos\\person.png"],
      imageRefsLeadWithScene: true,
    });
    expect(manifest.settings).toMatchObject({
      guidance_scale: 5, sample_solver: "default",
      custom_settings: { qwen21_kv_cache: "INT8", rgba: "Enabled", extra_setting: "kept" },
      image_guide: "C:\\frames\\carried.png",
      image_refs: ["C:\\photos\\person.png"],
      video_prompt_type: "IV", image_mode: 1,
    });
    expect(definition.defaultSettings).toMatchObject({
      guidance_scale: 4, sample_solver: "pruna",
      custom_settings: { qwen21_kv_cache: "Disabled", rgba: "Enabled" },
    });
    const submitted = toWangpSettings(manifest.settings, {
      prompt: "prompt", guidance_scale: "guidance_scale", sample_solver: "sample_solver",
    });
    expect(submitted.custom_settings).toEqual(manifest.settings.custom_settings);
    expect(client.calls).toHaveLength(0);
  });

  it("uses the same preset for a text-only Qwen frame", async () => {
    setWangpClient(new QwenClient());
    const manifest = await buildImageManifest(args());
    expect(manifest.settings.guidance_scale).toBe(5);
    expect(manifest.settings.sample_solver).toBe("default");
    expect(manifest.settings.custom_settings).toMatchObject({ qwen21_kv_cache: "INT8" });
  });

  it("recognizes a standard Qwen derivative by its base model", async () => {
    const definition = schema("custom_qwen");
    setWangpClient(new QwenClient(definition, "qwen_image_21_7B"));
    const manifest = await buildImageManifest(args("custom_qwen"));
    expect(manifest.settings.guidance_scale).toBe(5);
    expect(manifest.settings.custom_settings).toMatchObject({ qwen21_kv_cache: "INT8" });
  });

  it.each(["qwen_image_21_turbo_7B", "qwen_image_edit_plus_20B", "krea2_turbo_identity_edit_v2"])(
    "leaves %s generation defaults unchanged", async (type) => {
      const definition = schema(type);
      if (type.includes("_21_turbo_")) {
        definition.defaultSettings.guidance_scale = 1;
        definition.defaultSettings.sample_solver = "qwen21_turbo";
        definition.defaultSettings.num_inference_steps = 8;
      }
      setWangpClient(new QwenClient(definition, type.includes("_21_turbo_") ? "qwen_image_21_7B" : undefined));
      const manifest = await buildImageManifest(args(type));
      expect(manifest.settings.guidance_scale).toBe(definition.defaultSettings.guidance_scale);
      expect(manifest.settings.sample_solver).toBe(definition.defaultSettings.sample_solver);
      expect(manifest.settings.custom_settings).toEqual(definition.defaultSettings.custom_settings);
    },
  );

  it("does not apply the pin's Qwen preset to a substituted model", async () => {
    setWangpClient(new QwenClient(schema(), undefined, "different_image_model"));
    const manifest = await buildImageManifest(args());
    expect(manifest.modelType).toBe("qwen_image");
    expect(manifest.settings.guidance_scale).toBeUndefined();
    expect(manifest.settings.custom_settings).toBeUndefined();
  });

  it("fails explicitly when INT8 cache is not advertised", async () => {
    const definition = schema();
    definition.customSettings![0]!.allowed = ["Disabled", "Enabled"];
    const client = new QwenClient(definition);
    setWangpClient(client);
    await expect(buildImageManifest(args())).rejects.toThrow(/qwen21_kv_cache.*INT8/);
    expect(client.calls).toHaveLength(0);
  });

  it("fails explicitly when the cache declaration is absent", async () => {
    const definition = schema();
    delete definition.customSettings;
    setWangpClient(new QwenClient(definition));
    await expect(buildImageManifest(args())).rejects.toThrow(/qwen21_kv_cache/);
  });

  it("fails explicitly when FlowMatch Euler is unavailable", async () => {
    const definition = schema();
    definition.fields.find((field) => field.name === "sample_solver")!.allowed = ["pruna"];
    setWangpClient(new QwenClient(definition));
    await expect(buildImageManifest(args())).rejects.toThrow(/does not accept sampler 'default'/);
  });

  it("fails explicitly when CFG 5 is outside the published range", async () => {
    const definition = schema();
    definition.fields.find((field) => field.name === "guidance_scale")!.max = 4;
    setWangpClient(new QwenClient(definition));
    await expect(buildImageManifest(args())).rejects.toThrow(/does not accept Guidance \(CFG\) 5/);
  });

  it("does not silently accept malformed nested defaults", () => {
    const definition = schema();
    definition.defaultSettings.custom_settings = "invalid";
    expect(() => buildSettingsManifest(definition, {
      sceneId: "s1", purpose: "start_frame", prompt: "A teapot.",
      customSettings: { qwen21_kv_cache: "INT8" },
    })).toThrow(/invalid custom_settings defaults/);
  });

  it("does not reinterpret a Turbo base as a standard checkpoint", () => {
    expect(isQwen21Model({ modelType: "custom", baseModelType: "qwen_image_21_turbo_7B" })).toBe(true);
    expect(isStandardQwen21Model({ modelType: "custom", baseModelType: "qwen_image_21_turbo_7B" })).toBe(false);
  });
});
