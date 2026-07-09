import { describe, it, expect } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { selectVideoModel } from "@/lib/wangp/model-router";
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

  it("lists image models separately", async () => {
    const client = new MockWangpClient();
    const images = await client.listModels("image");
    expect(images.every((m) => m.metadata.mainOutput === "image")).toBe(true);
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
