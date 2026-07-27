import { describe, it, expect } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { produces } from "@/lib/wangp/model-router";
import { selectVideoModel } from "@/lib/wangp/model-router";
import { resolveModel } from "@/lib/wangp/resolve-model";
import { buildSettingsManifest } from "@/lib/wangp/settings";

describe("WanGP mock client — discovery → schema → manifest → job", () => {
  it("discovers models, builds a manifest, and completes a job", async () => {
    const client = new MockWangpClient();

    const videoModels = await client.listModels("video");
    expect(videoModels.length).toBeGreaterThan(0);
    expect(videoModels.every((m) => m.metadata.mainOutput === "video")).toBe(true);

    const model = selectVideoModel(videoModels, { modelStrategy: "prefer_wan" });
    expect(model?.modelType).toBe("wan_i2v_14b");

    const schema = await client.getModelSchema(model!.modelType);
    expect(schema.defaultSettings.model_type).toBe("wan_i2v_14b");

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "video_segment",
      prompt: "a lighthouse in a storm",
      fps: 24,
    });

    let job = await client.generate(manifest.settings);
    expect(job.status).toBe("submitted");

    job = await client.getJob(job.id); // running
    expect(job.status).toBe("running");
    job = await client.getJob(job.id); // completed
    expect(job.status).toBe("completed");
    expect(job.progress).toBe(100);
    expect(job.generatedFiles.length).toBe(1);
  });

  it("lists models by what they can produce, not just their primary output", async () => {
    const client = new MockWangpClient();
    const images = await client.listModels("image");
    // Every listed model must be able to produce an image — but a model whose
    // primary output is video still qualifies if it can render stills, which is
    // exactly how WanGP reports LTX-2.
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((m) => produces(m, "image"))).toBe(true);

    const videos = await client.listModels("video");
    expect(videos.every((m) => produces(m, "video"))).toBe(true);
  });

  it("cancels a job", async () => {
    const client = new MockWangpClient();
    const job = await client.generate({});
    const cancelled = await client.cancelJob(job.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("throws for an unknown model schema", async () => {
    const client = new MockWangpClient();
    await expect(client.getModelSchema("nope")).rejects.toThrow();
  });
});

describe("model pin resolution", () => {
  it("prefers an explicit pin over automatic selection", async () => {
    const client = new MockWangpClient();
    const videoModels = await client.listModels("video");
    const auto = selectVideoModel(videoModels, { modelStrategy: "auto" });
    const other = videoModels.find((m) => m.modelType !== auto?.modelType);
    expect(other).toBeDefined();

    const picked = resolveModel(videoModels, other!.modelType, () => auto, "video_segment");
    expect(picked.modelType).toBe(other!.modelType);
  });

  it("falls back to automatic selection when no pin is given", async () => {
    const client = new MockWangpClient();
    const videoModels = await client.listModels("video");
    const auto = selectVideoModel(videoModels, { modelStrategy: "prefer_wan" });

    expect(resolveModel(videoModels, undefined, () => auto, "video_segment").modelType).toBe(
      auto?.modelType,
    );
    // An empty pin is what a "use automatic" <option value=""> sends.
    expect(resolveModel(videoModels, "", () => auto, "video_segment").modelType).toBe(
      auto?.modelType,
    );
  });

  it("falls back rather than throwing when the pinned model is not in the catalog", async () => {
    const client = new MockWangpClient();
    const videoModels = await client.listModels("video");
    const auto = selectVideoModel(videoModels, { modelStrategy: "auto" });

    const picked = resolveModel(videoModels, "not_a_real_model", () => auto, "video_segment");
    expect(picked.modelType).toBe(auto?.modelType);
  });
});
