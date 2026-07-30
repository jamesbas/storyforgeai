import { describe, it, expect } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { selectImageModel, supportsReferenceImages } from "@/lib/wangp/model-router";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { buildImageManifest } from "@/lib/services/wangp-service";
import { setWangpClient } from "@/lib/wangp/factory";
import type { WangpModel } from "@/lib/schemas/wangp";

/**
 * Reference-image conditioning for the storyboard keyframes.
 *
 * The values asserted here were confirmed against a live WanGP: `image_refs`
 * takes a list of absolute paths, and the `"I"` letter in `video_prompt_type`
 * is what activates it. Both halves are enforced by the server — refs without
 * the letter are ignored, and the letter without refs fails the job — so a
 * regression in either one silently breaks character continuity.
 */

const REF_PATHS = ["C:\\lib\\characters\\elena.png"];

function imageModel(modelType: string, reference: boolean): WangpModel {
  return {
    modelType,
    name: modelType,
    metadata: {
      mainOutput: "image",
      outputs: ["image"],
      inputs: reference ? ["text", "image"] : ["text"],
      mediaInputs: { image: { reference } },
      availability: "available",
    },
  };
}

describe("reference images in the image manifest", () => {
  it("sets image_refs and the activating prompt-type letter together", async () => {
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("qwen_image");

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "start_frame",
      prompt: "a woman in a lighthouse doorway",
      imageRefs: REF_PATHS,
    });

    expect(manifest.settings.image_refs).toEqual(REF_PATHS);
    // "I" = "Conditional Images are People / Objects".
    expect(manifest.settings.video_prompt_type).toBe("I");
  });

  it("leaves the reference pathway untouched when no characters are pinned", async () => {
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("qwen_image");

    for (const imageRefs of [undefined, []]) {
      const manifest = buildSettingsManifest(schema, {
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        imageRefs,
      });
      expect(manifest.settings.image_refs).toBeUndefined();
      // An empty list must not set the letter: WanGP rejects the job with
      // "You must provide at least one Reference Image".
      expect(manifest.settings.video_prompt_type).toBe("");
    }
  });

  /**
   * Regression: the model's own default has to be overwritten, not just left
   * empty. Flux 2 Klein ships "MV" (mask + video guide), and a job carrying it
   * without a guide image is rejected with "You must provide a Control Image".
   * The case above passes on any model whose default is already blank.
   */
  it("clears a model default that would demand a guide image", () => {
    const schema = {
      modelType: "flux2_klein_9b",
      defaultSettings: { video_prompt_type: "MV" },
      fields: [
        { name: "prompt", type: "string" },
        { name: "video_prompt_type", type: "string" },
      ],
    };

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "start_frame",
      prompt: "a lighthouse",
    });

    expect(manifest.settings.video_prompt_type).toBe("");
  });

  it("never writes image_refs for a model that cannot accept them", async () => {
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("flux_dev_image");

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "start_frame",
      prompt: "a lighthouse",
      imageRefs: REF_PATHS,
    });
    expect(manifest.settings.image_refs).toBeUndefined();
  });

  it("uses KI when a scene frame leads the references, I when they are people", async () => {
    // "I" means the references are people/objects; "KI" means the first is the
    // main subject/landscape followed by people. Conditioning an end frame on
    // its start frame puts a scene image first, so the letter has to change.
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("qwen_image");

    const people = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "start_frame",
      prompt: "a woman in a garage",
      imageRefs: REF_PATHS,
    });
    expect(people.settings.video_prompt_type).toBe("I");

    const sceneFirst = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "end_frame",
      prompt: "the same woman, moments later",
      imageRefs: ["C:\\out\\scene-1-start.png", ...REF_PATHS],
      imageRefsLeadWithScene: true,
    });
    expect(sceneFirst.settings.video_prompt_type).toBe("KI");
    expect(sceneFirst.settings.image_refs).toEqual([
      "C:\\out\\scene-1-start.png",
      ...REF_PATHS,
    ]);
  });
});

describe("image model selection", () => {
  it("can restrict selection to reference-capable models", () => {
    const models = [imageModel("plain_image", false), imageModel("qwen_image_edit", true)];

    expect(selectImageModel(models, { modelStrategy: "auto" })).not.toBeNull();
    expect(
      selectImageModel(models, { modelStrategy: "auto" }, { requireReferenceImages: true })
        ?.modelType,
    ).toBe("qwen_image_edit");
  });

  it("prefers Flux 2 Klein as the default stills model", () => {
    const models = [
      imageModel("some_other_image", true),
      imageModel("flux2_klein_9b", true),
      imageModel("qwen_image_edit", true),
    ];
    expect(selectImageModel(models, { modelStrategy: "auto" })?.modelType).toBe("flux2_klein_9b");
  });

  it("reads reference support from the model capability flags", () => {
    expect(supportsReferenceImages(imageModel("a", true))).toBe(true);
    expect(supportsReferenceImages(imageModel("b", false))).toBe(false);
  });
});

describe("pinned model that cannot accept references", () => {
  it("substitutes a capable model rather than silently dropping the characters", async () => {
    // The pin is honoured for a normal render but must not be allowed to
    // swallow reference images: `buildSettingsManifest` only writes fields the
    // schema declares, so an incompatible pin would render with no character
    // conditioning and nothing to debug.
    setWangpClient(new MockWangpClient());
    try {
      const withoutRefs = await buildImageManifest({
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        modelStrategy: "auto",
        modelType: "flux_dev_image",
      });
      expect(withoutRefs.modelType).toBe("flux_dev_image");

      const withRefs = await buildImageManifest({
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        modelStrategy: "auto",
        modelType: "flux_dev_image",
        imageRefs: REF_PATHS,
      });
      expect(withRefs.modelType).not.toBe("flux_dev_image");
      expect(withRefs.settings.image_refs).toEqual(REF_PATHS);
      expect(withRefs.settings.video_prompt_type).toBe("I");
    } finally {
      setWangpClient(undefined);
    }
  });
});

describe("the frame the manifest asks for", () => {
  /**
   * The bug this pins: every manifest wrote the DEFAULT_RESOLUTION env value,
   * so a project set to 9:16 rendered landscape and the resolution preset did
   * nothing. Both fields were collected by the intake form, described on the
   * Help page, and read by nothing.
   */
  it("comes from the project, not the environment default", async () => {
    setWangpClient(new MockWangpClient());
    try {
      const portrait = await buildImageManifest({
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        modelStrategy: "auto",
        frame: { aspectRatio: "9:16", resolutionPreset: "standard" },
      });
      expect(portrait.settings.resolution).toBe("720x1280");

      const square = await buildImageManifest({
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        modelStrategy: "auto",
        frame: { aspectRatio: "1:1", resolutionPreset: "high" },
      });
      expect(square.settings.resolution).toBe("1024x1024");

      // The mock model publishes only three sizes, so a draft 16:9 target of
      // 848x480 snaps to the nearest landscape size it will actually accept.
      const draft = await buildImageManifest({
        sceneId: "scene-1",
        purpose: "start_frame",
        prompt: "a lighthouse",
        modelStrategy: "auto",
        frame: { aspectRatio: "16:9", resolutionPreset: "draft" },
      });
      expect(draft.settings.resolution).toBe("1280x720");
    } finally {
      setWangpClient(undefined);
    }
  });
});
