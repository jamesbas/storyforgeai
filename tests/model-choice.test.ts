import { describe, it, expect, beforeEach } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import {
  buildImageManifest,
  buildVideoManifest,
  previewModelChoice,
} from "@/lib/services/wangp-service";

/**
 * What the settings screen promises "Automatic" will do.
 *
 * The value of naming the resolved model is entirely in it being the same model
 * the render uses, so that is what is asserted: the preview and the manifest
 * builders are compared against each other rather than against a fixed name,
 * which would only prove the mock catalogue has not changed.
 */
beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

describe("previewModelChoice", () => {
  it("names the model the video build actually resolves", async () => {
    const preview = await previewModelChoice({ modelStrategy: "auto" });
    const manifest = await buildVideoManifest({
      sceneId: "s1",
      prompt: "A held shot of an empty road.",
      modelStrategy: "auto",
    });
    expect(preview.video?.modelType).toBe(manifest.modelType);
  });

  it("names the model the keyframe build actually resolves", async () => {
    const preview = await previewModelChoice({ modelStrategy: "auto" });
    const manifest = await buildImageManifest({
      sceneId: "s1",
      purpose: "start_frame",
      prompt: "An empty road at dawn.",
      modelStrategy: "auto",
    });
    expect(preview.image?.modelType).toBe(manifest.modelType);
  });

  it("follows the project's pin rather than the ranking", async () => {
    const preview = await previewModelChoice({ modelStrategy: "auto" });
    const pinned = await previewModelChoice({
      modelStrategy: "auto",
      videoModel: preview.video?.modelType,
    });
    expect(pinned.video?.modelType).toBe(preview.video?.modelType);
  });

  it("accounts for reference images narrowing the image choice", async () => {
    const withRefs = await previewModelChoice({
      modelStrategy: "auto",
      needsReferenceImages: true,
    });
    const manifest = await buildImageManifest({
      sceneId: "s1",
      purpose: "start_frame",
      prompt: "An empty road at dawn.",
      modelStrategy: "auto",
      imageRefs: ["/refs/mara.png"],
    });
    expect(withRefs.image?.modelType).toBe(manifest.modelType);
  });

  it("answers with null rather than throwing when nothing fits", async () => {
    class EmptyClient extends MockWangpClient {
      async listModels() {
        return [];
      }
    }
    setWangpClient(new EmptyClient());
    await expect(previewModelChoice({ modelStrategy: "auto" })).resolves.toEqual({
      image: null,
      video: null,
    });
  });
});
