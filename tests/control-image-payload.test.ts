import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImageManifest } from "@/lib/services/wangp-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { LiveWangpClient } from "@/lib/wangp/live-client";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { normalizeModelSchema } from "@/lib/wangp/mcp/normalize";
import { buildSettingsManifest } from "@/lib/wangp/settings";

const source = "C:\\frames\\carried.png";
const photos = Array.from({ length: 4 }, (_, index) => `C:\\photos\\person-${index + 1}.png`);
const modelType = "qwen_image_21_7B";
const metadata = {
  model_type: modelType, name: "Qwen Image 2.1", main_output: "image", family: "qwen_image_2",
  base_model_type: modelType,
  media_inputs: { image: { reference: true, multiple_references: true, control: true, mask: true } },
};
const definition = {
  image_outputs: true,
  guide_preprocessing: { selection: ["", "V"], labels: { V: "Control Image" } },
  sample_solvers: [["FlowMatch Euler", "default"]],
  custom_settings: [{ id: "qwen21_kv_cache", choices: ["Disabled", "INT8"] }],
};
const defaults = {
  model_type: modelType, prompt: "", resolution: "1024x1024", num_inference_steps: 40,
  guidance_scale: 4, sample_solver: "default",
  custom_settings: { qwen21_kv_cache: "Disabled", rgba: "Disabled" },
  // Saved UI state must not smuggle a mask, source or extra reference into this job.
  image_guide: "C:\\stale\\guide.png", image_mask: "C:\\stale\\mask.png",
  image_refs: ["C:\\stale\\reference.png"], video_prompt_type: "VAGKI", image_prompt_type: "SE",
  image_mode: 2,
};

function liveClient(contract: {
  metadata: Record<string, unknown>;
  definition: Record<string, unknown>;
  defaults: Record<string, unknown>;
} = { metadata, definition, defaults }) {
  vi.spyOn(WangpMcpTransport.prototype, "findTool").mockResolvedValue("wangp_models");
  vi.spyOn(WangpMcpTransport.prototype, "getToolInputSchema").mockResolvedValue({
    properties: { settings: {}, wait: { type: "boolean" } },
  });
  const call = vi.spyOn(WangpMcpTransport.prototype, "call").mockImplementation(async (name, args) => {
    if (name === "wangp_models") return { models: [contract.metadata], has_more: false };
    if (name === "wangp_model") {
      if (args?.action === "capabilities") return { metadata: contract.metadata };
      if (args?.action === "definition") return { definition: contract.definition };
      if (args?.action === "defaults") return { defaults: contract.defaults };
    }
    if (name === "wangp_generate") return { job_id: "mock-control-job" };
    throw new Error(`Unexpected tool ${name}`);
  });
  const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
  setWangpClient(client);
  return { client, call };
}

describe("Krea ordered edit source in the final MCP payload", () => {
  function kreaClient(type: string) {
    return liveClient({
      metadata: {
        model_type: type, name: type, main_output: "image", family: "krea2",
        base_model_type: "krea2_turbo_edit",
        media_inputs: { image: { reference: true, multiple_references: true, mask: true } },
      },
      definition: {
        image_outputs: true,
        image_ref_choices: { choices: [["Main scene first", "KI"], ["People or objects", "I"]] },
      },
      defaults: {
        model_type: type, prompt: "", resolution: "1024x1024", num_inference_steps: 8,
        image_refs: ["C:\\stale\\photo.png"],
        image_mode: 2, video_prompt_type: "VAG", image_prompt_type: "",
        image_mask: "C:\\stale\\mask.png",
      },
    });
  }

  it.each([
    "krea2_turbo_identity_edit_v2", "krea2_turbo_edit", "krea2_turbo_general_edit_v2", "krea2_raw_edit",
  ])("keeps the edit source first and selects KI for %s", async (type) => {
    const { client, call } = kreaClient(type);
    const manifest = await buildImageManifest({
      ...args, modelType: type, sourceImage: source, imageRefs: photos,
    });
    await client.generate(manifest.settings);
    const request = call.mock.calls.find(([name]) => name === "wangp_generate")?.[1];
    expect(request).toMatchObject({
      settings: {
        model_type: type, image_refs: [source, photos[0]], video_prompt_type: "KI", image_mode: 1,
      },
    });
    expect(request?.settings).not.toHaveProperty("image_guide");
    expect(request?.settings).not.toHaveProperty("image_mask");
  });

  it("uses the source as the sole main reference when no character photo is supplied", async () => {
    kreaClient("krea2_turbo_identity_edit_v2");
    const manifest = await buildImageManifest({
      ...args, modelType: "krea2_turbo_identity_edit_v2", sourceImage: source,
    });
    expect(manifest.settings.image_refs).toEqual([source]);
    expect(manifest.settings.video_prompt_type).toBe("KI");
    expect(manifest.settings).not.toHaveProperty("image_guide");
  });

  it("uses people-reference mode rather than main-scene mode when no source is supplied", async () => {
    kreaClient("krea2_turbo_identity_edit_v2");
    const manifest = await buildImageManifest({
      ...args, modelType: "krea2_turbo_identity_edit_v2", imageRefs: photos,
    });
    expect(manifest.settings.image_refs).toEqual(photos.slice(0, 2));
    expect(manifest.settings.video_prompt_type).toBe("I");
    expect(manifest.settings).not.toHaveProperty("image_guide");
  });
});

const args = {
  sceneId: "s2", purpose: "end_frame" as const, modelType, modelStrategy: "auto" as const,
  prompt: "Edit the supplied frame: place the cup on the table. Preserve the person's identity.",
};

afterEach(() => {
  setWangpClient(undefined);
  vi.restoreAllMocks();
});

describe("edit source roles in the final MCP payload", () => {
  it("sends the source as Control Image and four identity photos as people references", async () => {
    const { client, call } = liveClient();
    const manifest = await buildImageManifest({ ...args, sourceImage: source, imageRefs: photos });
    await client.generate(manifest.settings);
    const requests = call.mock.calls.filter(([name]) => name === "wangp_generate");
    expect(requests).toHaveLength(1);
    expect(requests[0]![1]).toMatchObject({
      settings: {
        model_type: modelType, image_guide: source, image_refs: photos,
        video_prompt_type: "IV", image_prompt_type: "", image_mode: 1,
        guidance_scale: 5, sample_solver: "default",
        custom_settings: { qwen21_kv_cache: "INT8", rgba: "Disabled" },
      },
      wait: false,
    });
    const payload = requests[0]![1]?.settings;
    expect(payload).not.toHaveProperty("image_mask");
    expect(defaults.image_mode).toBe(2);
    expect(defaults.image_refs).toEqual(["C:\\stale\\reference.png"]);
  });

  it("activates only control when there are no character photos", async () => {
    const { client, call } = liveClient();
    const manifest = await buildImageManifest({ ...args, sourceImage: source });
    await client.generate(manifest.settings);
    expect(call.mock.calls.find(([name]) => name === "wangp_generate")?.[1]).toMatchObject({
      settings: { image_guide: source, image_refs: [], video_prompt_type: "V", image_mode: 1 },
    });
    expect(manifest.settings).not.toHaveProperty("image_mask");
  });

  it("keeps ordinary generation and reference opt-outs free of a Control Image", async () => {
    liveClient();
    const manifest = await buildImageManifest({ ...args, imageRefs: photos });
    expect(manifest.settings.image_refs).toEqual(photos);
    expect(manifest.settings.video_prompt_type).toBe("I");
    expect(manifest.settings.image_mode).toBe(1);
    expect(manifest.settings.image_prompt_type).toBe("");
    expect(manifest.settings).not.toHaveProperty("image_guide");
    expect(manifest.settings).not.toHaveProperty("image_mask");
  });

  it("maps legacy ordered-source callers to the same control payload", async () => {
    liveClient();
    const explicit = await buildImageManifest({ ...args, sourceImage: source, imageRefs: photos });
    const ordered = await buildImageManifest({
      ...args, imageRefs: [source, ...photos], imageRefsLeadWithScene: true,
    });
    expect(ordered.settings).toEqual(explicit.settings);
  });

  it("does not accept two competing source designations", async () => {
    liveClient();
    await expect(buildImageManifest({
      ...args, sourceImage: source, imageRefs: [source, ...photos], imageRefsLeadWithScene: true,
    })).rejects.toThrow(/not both/);
  });

  it("preserves reference-only model handling when no control input exists", () => {
    const schema = {
      modelType: "reference-only",
      defaultSettings: {},
      fields: ["prompt", "image_refs", "video_prompt_type"].map((name) => ({ name, type: "string" })),
    };
    const manifest = buildSettingsManifest(schema, {
      ...args, imageRefs: [source, ...photos], imageRefsLeadWithScene: true,
    });
    expect(manifest.settings).toMatchObject({
      image_refs: [source, ...photos], video_prompt_type: "KI",
    });
    expect(manifest.settings).not.toHaveProperty("image_guide");
  });

  it("fails rather than silently dropping an explicitly supplied unsupported control input", () => {
    const schema = normalizeModelSchema("no-guide", { properties: {
      prompt: {}, image_refs: {}, video_prompt_type: {},
    } }, {}).schema;
    expect(() => buildSettingsManifest(schema, {
      ...args, imageGuide: source, imageRefs: photos,
    })).toThrow(/does not accept image_guide/);
  });

  it("fails if a model cannot activate its declared control input", () => {
    const schema = { modelType: "no-control-mode", defaultSettings: {}, fields: [
      { name: "prompt", type: "string" }, { name: "image_guide", type: "string" },
    ] };
    expect(() => buildSettingsManifest(schema, { ...args, imageGuide: source })).toThrow(/cannot activate/);
  });

  it("does not allow a control source to be suppressed by inherited reference modes", () => {
    const schema = normalizeModelSchema(modelType, { ...definition, metadata }, defaults).schema;
    expect(() => buildSettingsManifest(schema, {
      ...args, imageGuide: source, keepModelReferenceGroup: true,
    })).toThrow(/requires explicit control and reference modes/);
  });

  it("rejects a blank control-image path", () => {
    const schema = normalizeModelSchema(modelType, { ...definition, metadata }, defaults).schema;
    expect(() => buildSettingsManifest(schema, {
      ...args, imageGuide: "",
    })).toThrow(/non-empty path/);
  });
});
