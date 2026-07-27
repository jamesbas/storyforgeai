import { describe, it, expect } from "vitest";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";
import { wangpGenerationSettingsSchema } from "@/lib/schemas/wangp";
import { toCapability, rankVideoModels, selectVideoModel } from "@/lib/wangp/model-router";
import { buildSettingsManifest, frameCountForFps } from "@/lib/wangp/settings";

const wan: WangpModel = {
  modelType: "wan_i2v_14b",
  name: "Wan",
  metadata: {
    mainOutput: "video",
    inputs: ["text", "image"],
    mediaInputs: { image: { start: true, end: true } },
    qualityRank: 90,
    recommendedFps: [16, 24],
    maxFrames: 481,
  },
};
const ltx: WangpModel = {
  modelType: "ltx_video",
  name: "LTX",
  metadata: {
    mainOutput: "video",
    inputs: ["text", "image"],
    mediaInputs: { image: { start: true } },
    qualityRank: 78,
    recommendedFps: [24],
  },
};
const hunyuan: WangpModel = {
  modelType: "hunyuan_video",
  name: "Hunyuan",
  metadata: { mainOutput: "video", inputs: ["text"], qualityRank: 95 },
};

describe("model router", () => {
  it("derives start/end frame capability", () => {
    const cap = toCapability(wan);
    expect(cap.supportsStartFrame).toBe(true);
    expect(cap.supportsEndFrame).toBe(true);
    expect(cap.outputs).toContain("video");
  });

  it("ranks start-frame models above a higher-quality text-only model", () => {
    const ranked = rankVideoModels([hunyuan, wan, ltx], { modelStrategy: "auto" });
    // hunyuan has the highest qualityRank but no start frame -> must not be first.
    expect(ranked[0]!.modelType).not.toBe("hunyuan_video");
    expect(["wan_i2v_14b", "ltx_video"]).toContain(ranked[0]!.modelType);
  });

  it("honors the model strategy preference", () => {
    const selected = selectVideoModel([wan, ltx], { modelStrategy: "prefer_ltx" });
    expect(selected?.modelType).toBe("ltx_video");
  });
});

const videoSchema: WangpModelSchema = {
  modelType: "wan_i2v_14b",
  defaultSettings: {
    model_type: "wan_i2v_14b",
    prompt: "",
    negative_prompt: "",
    resolution: "1280x720",
    force_fps: 24,
    video_length: 481,
    num_inference_steps: 8,
  },
  fields: [
    { name: "prompt", type: "string" },
    { name: "negative_prompt", type: "string" },
    { name: "resolution", type: "string", allowed: ["1280x720"] },
    { name: "force_fps", type: "number", allowed: [16, 24] },
    { name: "video_length", type: "number" },
    { name: "image_start", type: "string" },
    { name: "image_end", type: "string" },
  ],
};

describe("settings manifest", () => {
  it("derives 20s frame count from fps", () => {
    expect(frameCountForFps(24)).toBe(481);
    expect(frameCountForFps(16)).toBe(321);
    expect(frameCountForFps(30)).toBe(601);
  });

  it("builds a schema-valid manifest from defaults and overrides", () => {
    const manifest = buildSettingsManifest(videoSchema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "a robot paints",
      negativePrompt: "blurry",
      imageStart: "C:/abs/start.png",
      fps: 16,
    });
    expect(() => wangpGenerationSettingsSchema.parse(manifest)).not.toThrow();
    expect(manifest.settings.prompt).toBe("a robot paints");
    expect(manifest.settings.force_fps).toBe(16);
    expect(manifest.settings.video_length).toBe(frameCountForFps(16));
    expect(manifest.settings.image_start).toBe("C:/abs/start.png");
    expect(manifest.status).toBe("draft");
  });

  it("falls back to an allowed fps when an unsupported value is requested", () => {
    const manifest = buildSettingsManifest(videoSchema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 60, // not allowed -> first allowed (16)
    });
    expect(manifest.settings.force_fps).toBe(16);
    expect(manifest.settings.video_length).toBe(frameCountForFps(16));
  });

  it("scales frame count with a shorter segment duration", () => {
    // 8-frame alignment plus one, so a 5s clip at 24fps is 121 frames not 120.
    expect(frameCountForFps(24, 5)).toBe(121);
    expect(frameCountForFps(16, 5)).toBe(81);

    const manifest = buildSettingsManifest(videoSchema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 16,
      durationSeconds: 5,
    });
    expect(manifest.settings.video_length).toBe(frameCountForFps(16, 5));
    // A shorter clip must not silently inherit the model's default length.
    expect(manifest.settings.video_length).not.toBe(frameCountForFps(16));
  });
});
