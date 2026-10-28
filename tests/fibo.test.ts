import { afterEach, describe, expect, it, vi } from "vitest";
import { zodResponseFormat } from "openai/helpers/zod";
import {
  fiboCaptionSchema, fiboCaptionOf, fiboPromptText, fiboRenderPrompt,
  fiboTextPreserved, mapFiboDescription, parseFiboPrompt, serialiseFiboPrompt,
  writeFiboPrompts, FIBO_VGL_SYSTEM,
} from "@/lib/agents/fibo-prompt";
import { imagePromptDirective } from "@/lib/agents/model-directives";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief, buildSceneDrafts, buildStoryPlan, buildVisualBible,
} from "@/lib/agents/mock-agents";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { ArtifactExecution } from "@/lib/schemas/provenance";
import {
  createProject, generateStoryboard, getProjectRecord, updateScenePrompts,
} from "@/lib/services/project-service";
import { addImagePromptText } from "@/lib/services/prompt-tools-service";
import { simplifyPrompt } from "@/lib/agents/prompt-simplifier";
import { buildImageManifest } from "@/lib/services/wangp-service";
import { wangpGenerationSettingsSchema, type WangpModel, type WangpModelSchema } from "@/lib/schemas/wangp";
import { familyOf, familyOfModel, supportsNegativePrompt } from "@/lib/wangp/family";
import { selectImageModel, referenceImageCapacity } from "@/lib/wangp/model-router";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { resolveResolution } from "@/lib/wangp/resolution";
import { resolveSteps } from "@/lib/wangp/steps";
import { APP_VERSION } from "@/lib/version";

const source = 'Medium shot, eye level. A matte blue mug sits left of a walnut desk. A sign reads "OPEN".';
const caption = {
  short_description: source,
  objects: [
    { description: "A matte blue ceramic mug", location: "left on the desk", relative_size: "small" },
    { description: 'A sign reading "OPEN"', location: "behind the mug" },
  ],
  background_setting: "An uncluttered cream wall",
  lighting: { conditions: "soft window light", direction: "from the left" },
  aesthetics: { composition: "empty space on the right" },
  photographic_characteristics: { camera_angle: "eye level, three-quarter view" },
  style_medium: "photograph",
  text_render: [{ text: "OPEN", location: "on the sign", typography: "bold sans-serif" }],
};
const json = serialiseFiboPrompt(caption);

function model(modelType: string): WangpModel {
  return {
    modelType, name: modelType,
    metadata: {
      mainOutput: "image", inputs: ["text", "image"], family: "fibo2",
      baseModelType: modelType, supportsLora: true,
      mediaInputs: { image: { reference: true, multipleReferences: true } },
    },
  };
}

class FiboClient extends MockWangpClient {
  async listModels(output?: "image" | "video" | "audio") {
    return output === "image" || output === undefined
      ? [model("fibo2_dev"), model("fibo2_edit_turbo")]
      : super.listModels(output);
  }
  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    const turbo = modelType.includes("turbo");
    return {
      modelType,
      defaultSettings: {
        model_type: modelType, prompt: "", resolution: "4096x4096",
        // Deliberately polluted UI state: these must not choose the render.
        num_inference_steps: turbo ? 50 : 4, guidance_scale: turbo ? 9 : 1,
        prompt_enhancer: "TI1", video_prompt_type: "VA",
        spatial_upsampling: "lanczos2",
        remove_background_images_ref: 1, image_refs: ["old.png"],
        multi_prompts_gen_type: "PG", batch_size: 2, seed: -1,
        activated_loras: [], loras_multipliers: "",
      },
      fields: [
        "prompt", "resolution", "num_inference_steps", "seed", "image_refs",
        "video_prompt_type", "activated_loras", "loras_multipliers",
        ...(turbo ? [] : ["negative_prompt", "guidance_scale"]),
      ].map((name) => ({ name, type: "string" })),
    };
  }
}

const manifestArgs = (modelType = "fibo2_dev") => ({
  sceneId: "s1", purpose: "start_frame" as const, prompt: json,
  modelType, modelStrategy: "auto" as const, seed: 42,
  frame: { aspectRatio: "1:1" as const, resolutionPreset: "high" as const },
});

afterEach(() => setWangpClient(undefined));

describe("Fibo family and guidance", () => {
  it("recognizes Dev, Turbo and named derivatives without confusing the Qwen encoder", () => {
    expect(familyOf("fibo2_dev")).toBe("fibo");
    expect(familyOf("fibo2_edit_turbo")).toBe("fibo_turbo");
    expect(familyOf("qwen_encoder", "fibo2")).toBe("fibo");
    expect(familyOfModel({
      modelType: "custom_checkpoint",
      metadata: { ...model("fibo2_dev").metadata, baseModelType: "fibo2_edit_turbo" },
    })).toBe("fibo_turbo");
    expect(supportsNegativePrompt("fibo")).toBe(true);
    expect(supportsNegativePrompt("fibo_turbo")).toBe(false);
    expect(imagePromptDirective("fibo")).toMatch(/placement.*materials/);
    expect(imagePromptDirective("fibo_turbo")).toMatch(/desired local result/);
  });

  it("does not automatically choose editing-only Turbo for text-only generation", () => {
    const turbo = model("fibo2_edit_turbo");
    expect(selectImageModel([turbo], { modelStrategy: "auto" })).toBeNull();
    expect(selectImageModel([turbo], { modelStrategy: "auto" }, { requireReferenceImages: true }))
      .toEqual(turbo);
    expect(referenceImageCapacity(turbo)).toBe(4);
  });

  it.each([4, 20, 30, 50, 100, undefined])("keeps Dev in the 30–50 step range with default %s", (modelDefault) => {
    const value = resolveSteps({
      modelType: "fibo2_dev", modelDefault, loras: [], override: undefined, floor: 45,
    })!;
    expect(value.steps).toBeGreaterThanOrEqual(30);
    expect(value.steps).toBeLessThanOrEqual(50);
  });

  it("uses four steps for Turbo, but honors an explicit project override", () => {
    const args = { modelType: "fibo2_edit_turbo", modelDefault: 50, loras: [], floor: 45 };
    expect(resolveSteps({ ...args, override: undefined })).toMatchObject({ steps: 4 });
    expect(resolveSteps({ ...args, override: 8 })).toMatchObject({ steps: 8, reason: "project_override" });
  });

  it("renders at about one megapixel on a 16-pixel grid for every shape and preset", () => {
    for (const aspectRatio of ["16:9", "9:16", "1:1", "custom"] as const) {
      for (const preset of ["draft", "standard", "high"] as const) {
        const [width = 0, height = 0] = resolveResolution({
          aspectRatio, preset, fallback: "3840x2160", family: "fibo",
        }).split("x").map(Number);
        expect(width % 16).toBe(0);
        expect(height % 16).toBe(0);
        expect(width * height).toBeGreaterThanOrEqual(1_000_000);
        expect(width * height).toBeLessThanOrEqual(1_180_000);
        if (aspectRatio === "9:16") expect(height).toBeGreaterThan(width);
        if (aspectRatio === "16:9") expect(width).toBeGreaterThan(height);
      }
    }
    expect(resolveResolution({
      aspectRatio: "1:1", preset: "high", fallback: "", family: "fibo",
    })).toBe("1024x1024");
    expect(resolveResolution({
      aspectRatio: "16:9", preset: "high", fallback: "", family: "flux",
    })).toBe("1920x1088");
  });
});

describe("Fibo VGL", () => {
  it("converts through the provider's strict JSON schema format", () => {
    expect(() => zodResponseFormat(fiboCaptionSchema, "Fibo")).not.toThrow();
  });

  it("round-trips full captions, quoted lettering, hex colours and structured edits", () => {
    const prompt = fiboRenderPrompt(json, 2, true);
    const parsed = parseFiboPrompt(prompt)!;
    expect(fiboCaptionOf(parsed)).toEqual(caption);
    expect(parsed.edit_instruction).toContain("<image_1>");
    expect(parsed.edit_instruction).toContain("<image_2>");
    expect(parsed.edit_instruction).not.toContain("<image_3>");
    expect(parseFiboPrompt(fiboRenderPrompt(prompt, 2, true))).toEqual(parsed);
    expect(fiboPromptText(json)).toContain("walnut desk");
    expect(mapFiboDescription(json, (text) => `${text} A #112233 border.`)).toContain("#112233");
    expect(JSON.parse(fiboRenderPrompt(source, 0, false))).toEqual({ short_description: source });
  });

  it("refuses malformed JSON and an edit without a source", () => {
    expect(() => parseFiboPrompt('{"short_description":"unfinished')).toThrow(/Invalid Fibo/);
    expect(() => parseFiboPrompt('{"made_up":"not VGL"}')).toThrow(/Invalid Fibo/);
    expect(() => fiboRenderPrompt(fiboRenderPrompt(json, 1, false), 0, false)).toThrow(/needs a source/);
    expect(() => fiboRenderPrompt(JSON.stringify({
      structured_caption: caption, edit_instruction: "Use the subject from <image_3>.",
    }), 2, false)).toThrow(/not being sent/);
  });

  it("uses the configured planner once for both frames and records conversion provenance", async () => {
    const executions: ArtifactExecution[] = [];
    const generateJson = vi.fn();
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async (system, _user, schema) => {
        generateJson(system);
        return schema.parse({ start: caption, end: caption });
      },
    };
    const result = await writeFiboPrompts({
      start: source, end: source, sceneId: "s1", provider,
      onExecution: (execution) => executions.push(execution),
    });

    expect(JSON.parse(result.start)).toEqual(caption);
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]?.[0]).toBe(FIBO_VGL_SYSTEM);
    expect(executions[0]).toMatchObject({
      artifact: "s1.image_vgl", source: "llm", status: "ok", promptVersion: "fibo-vgl-v1",
    });
  });

  it("records a supported short-caption fallback rather than silently accepting invented text", async () => {
    const executions: ArtifactExecution[] = [];
    const provider: PlanningProvider = {
      name: "test", generateJson: async (_system, _user, schema) => schema.parse({
        start: { ...caption, text_render: [{ text: "INVENTED WORDS" }] }, end: caption,
      }),
    };
    const result = await writeFiboPrompts({
      start: source, end: source, sceneId: "s1", provider,
      onExecution: (execution) => executions.push(execution),
    });
    expect(JSON.parse(result.start)).toEqual({ short_description: source });
    expect(executions[0]).toMatchObject({
      source: "deterministic", status: "degraded", fallbackReason: "invalid_set",
    });
  });

  it("rejects a conversion that loses an established person or changes the headcount", async () => {
    for (const start of ["Exactly two people in frame.", "Mara sits beside the desk."]) {
      const executions: ArtifactExecution[] = [];
      const provider: PlanningProvider = {
        name: "test", generateJson: async (_system, _user, schema) => schema.parse({
          start: { short_description: "Exactly one person in frame." },
          end: { short_description: source },
        }),
      };
      await writeFiboPrompts({
        start, end: source, sceneId: "s1", provider, participants: ["Mara"],
        onExecution: (execution) => executions.push(execution),
      });
      expect(executions[0]?.fallbackReason).toBe("invalid_set");
    }
  });

  it("saves JSON only for rewritten Fibo image passes and preserves a skipped pass", async () => {
    const project = {
      ...await createProject({ concept: "A blue mug on a walnut desk.", requestedDurationSeconds: 20 }),
      imageModel: "fibo2_dev",
    };
    const drafts = buildSceneDrafts(
      project, buildStoryPlan(project), buildCreativeBrief(project), buildVisualBible(project),
    );
    const scenes = await attachScenePrompts(project, drafts, null);
    expect(parseFiboPrompt(scenes[0]!.prompts.startFramePrompt)).not.toBeNull();
    expect(parseFiboPrompt(scenes[0]!.prompts.endFramePrompt)).not.toBeNull();
    const generateJson = vi.fn(async () => null);
    const kept = await attachScenePrompts(project, drafts, { name: "test", generateJson }, {
      passes: ["video"],
      existing: Object.fromEntries(scenes.map((scene) => [scene.id, scene.prompts])),
    });
    expect(kept[0]!.prompts.startFramePrompt).toBe(scenes[0]!.prompts.startFramePrompt);
    expect(generateJson.mock.calls.some((call: unknown[]) => call[0] === FIBO_VGL_SYSTEM)).toBe(false);
  });

  it("preserves JSON, object count and exact lettering when editing descriptions", () => {
    const next = mapFiboDescription(json, () => "A mug on a desk.");
    expect(fiboTextPreserved(json, next)).toBe(true);
    expect(fiboTextPreserved(json, "A mug on a desk.")).toBe(false);
    expect(fiboTextPreserved(json, JSON.stringify({ ...caption, text_render: [] }))).toBe(false);
    expect(fiboTextPreserved(json, JSON.stringify({ ...caption, objects: [] }))).toBe(false);
  });
});

describe("Fibo prompt editing", () => {
  async function savedScene() {
    const project = await createProject({
      concept: "A blue ceramic mug on a desk.", requestedDurationSeconds: 20,
    });
    const record = await generateStoryboard(project.id);
    const sceneId = record.storyboard!.scenes[0]!.id;
    await updateScenePrompts(project.id, sceneId, { startFramePrompt: json, endFramePrompt: json });
    return { project, sceneId };
  }

  it("adds literal text inside the caption, leaving JSON, objects and exact lettering intact", async () => {
    const { project, sceneId } = await savedScene();
    const record = await addImagePromptText(project.id, {
      scope: "selected", sceneIds: [sceneId], frames: "start",
      placement: "append", text: "The desk has a visible walnut grain.",
    });
    const prompt = record.storyboard!.scenes[0]!.prompts.startFramePrompt;
    expect(fiboCaptionOf(parseFiboPrompt(prompt)!).short_description)
      .toBe(`${source}\nThe desk has a visible walnut grain.`);
    expect(fiboTextPreserved(json, prompt)).toBe(true);
    expect(record.storyboard!.scenes[0]!.prompts.endFramePrompt).toBe(json);
  });

  it("refuses a malformed hand edit without saving it", async () => {
    const { project, sceneId } = await savedScene();
    await expect(updateScenePrompts(project.id, sceneId, {
      startFramePrompt: '{"short_description":"unclosed',
    })).rejects.toThrow(/Invalid Fibo/);
    expect((await getProjectRecord(project.id)).storyboard!.scenes[0]!.prompts.startFramePrompt).toBe(json);
  });

  it("simplifies VGL descriptions without replacing the JSON with prose", async () => {
    const { project } = await savedScene();
    const scene = (await getProjectRecord(project.id)).storyboard!.scenes[0]!;
    const shorter = mapFiboDescription(json, () => 'Medium shot, eye level. Blue mug left on desk; "OPEN" sign behind.');
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async (_system, _user, schema) => schema.parse({ prompt: shorter }),
    };
    expect(await simplifyPrompt(scene, "startFramePrompt", provider)).toBe(shorter);
    const invalid: PlanningProvider = {
      name: "test", generateJson: async (_system, _user, schema) => schema.parse({ prompt: "A mug." }),
    };
    await expect(simplifyPrompt(scene, "startFramePrompt", invalid)).rejects.toThrow();
  });
});

describe("Fibo manifests", () => {
  it("preserves the reviewed JSON and seed with Dev sampling and native resolution", async () => {
    const client = new FiboClient();
    const generate = vi.spyOn(client, "generate");
    setWangpClient(client);
    const manifest = await buildImageManifest(manifestArgs());
    expect(JSON.parse(String(manifest.settings.prompt))).toEqual(caption);
    expect(manifest.settings).toMatchObject({
      seed: 42, num_inference_steps: 45, guidance_scale: 5, resolution: "1024x1024",
      prompt_enhancer: "", multi_prompts_gen_type: "FG", image_refs: [],
      video_prompt_type: "", batch_size: 1,
      spatial_upsampling: "",
    });
    expect(manifest.reproducibility).toMatchObject({
      storyforgeVersion: APP_VERSION, baseModelType: "fibo2_dev",
    });
    expect(wangpGenerationSettingsSchema.parse(manifest).reproducibility).toEqual(manifest.reproducibility);
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires a source for Turbo and uses ordered references without copying their dimensions", async () => {
    setWangpClient(new FiboClient());
    await expect(buildImageManifest(manifestArgs("fibo2_edit_turbo"))).rejects.toThrow(/requires a source/);
    const manifest = await buildImageManifest({
      ...manifestArgs("fibo2_edit_turbo"),
      imageRefs: ["C:\\refs\\scene.png", "C:\\refs\\person.png"],
      imageRefsLeadWithScene: true,
      negativePrompt: "blur, watermark",
    });
    expect(manifest.settings).toMatchObject({
      num_inference_steps: 4, guidance_scale: 1, video_prompt_type: "I",
      remove_background_images_ref: 0, resolution: "1024x1024",
    });
    expect(manifest.settings.negative_prompt).toBeUndefined();
    const prompt = parseFiboPrompt(String(manifest.settings.prompt))!;
    expect(prompt.edit_instruction).toContain("Update <image_1>");
    expect(prompt.edit_instruction).toContain("<image_2> as subject identity");
    expect(fiboCaptionOf(prompt).text_render).toEqual(caption.text_render);
  });

  it("limits reference numbering to the actual four images sent to Wan2GP", async () => {
    setWangpClient(new FiboClient());
    const manifest = await buildImageManifest({
      ...manifestArgs("fibo2_edit_turbo"),
      imageRefs: Array.from({ length: 5 }, (_, i) => `C:\\refs\\${i}.png`),
    });
    expect(manifest.settings.image_refs).toHaveLength(4);
    const prompt = String(manifest.settings.prompt);
    expect(prompt).toContain("<image_4>");
    expect(prompt).not.toContain("<image_5>");
  });

  it("keeps a structured Dev negative caption intact and honors explicit steps", async () => {
    setWangpClient(new FiboClient());
    const negative = '{"short_description":"","objects":[{"description":"soft, waxy skin"}]}';
    const manifest = await buildImageManifest({ ...manifestArgs(), negativePrompt: negative, steps: 36 });
    expect(manifest.settings.negative_prompt).toBe(negative);
    expect(manifest.settings.num_inference_steps).toBe(36);
  });

  it("flattens saved VGL when a different image family actually renders it", async () => {
    setWangpClient(new MockWangpClient());
    const manifest = await buildImageManifest({ ...manifestArgs("flux_dev_image"), prompt: json });
    expect(String(manifest.settings.prompt)).toContain("matte blue");
    expect(String(manifest.settings.prompt).trimStart()).not.toMatch(/^\{/);
    expect(manifest.reproducibility).toBeUndefined();
  });
});
