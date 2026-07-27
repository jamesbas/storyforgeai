import { describe, it, expect } from "vitest";
import {
  knownKeys,
  normalizeChoices,
  normalizeJob,
  normalizeModel,
  normalizeModelSchema,
  numericRange,
} from "@/lib/wangp/mcp/normalize";
import { resolveFieldMap, toWangpSettings } from "@/lib/wangp/mcp/aliases";
import { unwrapStructuredContent, parseTextContent, ALLOWED_TOOLS } from "@/lib/wangp/mcp/transport";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import {
  findPinned,
  selectAudioModel,
  selectImageModel,
  selectVideoModel,
  produces,
  toCapability,
  videoModelsWithAudio,
} from "@/lib/wangp/model-router";
import { MockWangpClient } from "@/lib/wangp/mock-client";

/** Shape returned by a real `wangp_list_models` entry (snake_case, no metadata). */
const ltxListEntry = {
  model_type: "ltxv_2_distilled",
  name: "LTX Video 2 Distilled",
  model_family: "ltxv",
  main_output: "video",
};

const ltxMetadata = {
  main_output: "video",
  media_inputs: { image: { start: true, end: true, reference: false } },
  loras: true,
  model_def: { max_frames: 601 },
};

describe("normalizeModel", () => {
  it("maps a snake_case list entry enriched with metadata", () => {
    const model = normalizeModel(ltxListEntry, ltxMetadata);
    expect(model).not.toBeNull();
    expect(model!.modelType).toBe("ltxv_2_distilled");
    expect(model!.metadata.mainOutput).toBe("video");
    expect(model!.metadata.mediaInputs?.image?.start).toBe(true);
    expect(model!.metadata.mediaInputs?.image?.end).toBe(true);
    expect(model!.metadata.supportsLora).toBe(true);
    expect(model!.metadata.maxFrames).toBe(601);
  });

  it("always includes text as an input and skips unknown outputs", () => {
    expect(normalizeModel({ model_type: "x", main_output: "video" })!.metadata.inputs).toContain("text");
    expect(normalizeModel({ model_type: "x", main_output: "mesh" })).toBeNull();
    expect(normalizeModel({ name: "no model type" })).toBeNull();
  });

  it("accepts main_output delivered as an array", () => {
    expect(normalizeModel({ model_type: "q", main_output: ["image"] })!.metadata.mainOutput).toBe("image");
  });

  it("feeds the existing model router without changes", () => {
    const models = [
      normalizeModel({ model_type: "txt_only", main_output: "video" })!,
      normalizeModel(ltxListEntry, ltxMetadata)!,
    ];
    expect(selectVideoModel(models, { modelStrategy: "auto" })!.modelType).toBe("ltxv_2_distilled");
  });
});

/**
 * WanGP's real metadata record (models/model_metadata.py `store_metadata`):
 * `main_output` is an array, `outputs` widens it with "audio" for models whose
 * handler sets `returns_audio`, and `media_inputs` always contains all three
 * groups with a full set of boolean flags.
 */
describe("normalizeModel against WanGP metadata records", () => {
  const ltx2Record = {
    model_type: "ltx2_22B",
    name: "LTX-2 2.3 Dev 1.0 22B",
    family: "ltx2",
    main_output: ["video"],
    outputs: ["video", "audio"],
    inputs: ["text", "image", "audio"],
    media_inputs: {
      image: { start: true, end: true, reference: false, control: false, mask: false },
      video: { continue: true, last: false, control: false, mask: false },
      audio: { prompt: true, output: true },
    },
  };

  const stableAudioRecord = {
    model_type: "stable_audio3_small",
    name: "Music Stable Audio 3 Small Music",
    family: "stable_audio3",
    main_output: ["audio"],
    outputs: ["audio"],
    inputs: ["text"],
    media_inputs: {
      image: { start: false, end: false, reference: false, control: false, mask: false },
      video: { continue: false, last: false, control: false, mask: false },
      audio: { prompt: false, output: true },
    },
  };

  it("keeps LTX-2 a video model while recording that it emits audio", () => {
    const model = normalizeModel(ltx2Record)!;
    expect(model.metadata.mainOutput).toBe("video");
    expect(model.metadata.outputs).toEqual(["video", "audio"]);
    expect(model.metadata.mediaInputs?.audio).toEqual({ prompt: true, output: true });

    const cap = toCapability(model);
    expect(cap.supportsAudioOutput).toBe(true);
    expect(cap.acceptsAudioPrompt).toBe(true);
    expect(cap.supportsStartFrame).toBe(true);
    expect(cap.supportsEndFrame).toBe(true);
  });

  it("surfaces a dedicated audio generator", () => {
    const model = normalizeModel(stableAudioRecord)!;
    expect(model.metadata.mainOutput).toBe("audio");
    expect(toCapability(model).supportsAudioOutput).toBe(true);
    expect(toCapability(model).acceptsAudioPrompt).toBe(false);
    expect(selectAudioModel([model], { modelStrategy: "auto" })!.modelType).toBe(
      "stable_audio3_small",
    );
  });

  it("does not treat always-present media_inputs groups as real inputs", () => {
    // Every flag is false, so no media kind should be reported as an input.
    const silent = normalizeModel({
      model_type: "plain",
      main_output: ["video"],
      inputs: ["text"],
      media_inputs: {
        image: { start: false, end: false, reference: false },
        video: { continue: false, last: false },
        audio: { prompt: false, output: false },
      },
    })!;
    expect(silent.metadata.inputs).toEqual(["text"]);
  });

  it("separates audio output from audio input", () => {
    const model = normalizeModel({
      model_type: "outputs_audio_only",
      main_output: ["video"],
      outputs: ["video", "audio"],
      inputs: ["text"],
      media_inputs: { audio: { prompt: false, output: true } },
    })!;
    // An audio *output* must not become an audio *input*.
    expect(model.metadata.inputs).toEqual(["text"]);
    expect(toCapability(model).supportsAudioOutput).toBe(true);
    expect(toCapability(model).acceptsAudioPrompt).toBe(false);
  });

  it("finds video models that carry their own soundtrack", () => {
    const models = [normalizeModel(ltx2Record)!, normalizeModel({ model_type: "silent", main_output: ["video"] })!];
    expect(videoModelsWithAudio(models).map((m) => m.modelType)).toEqual(["ltx2_22B"]);
  });

  it("picks the first main_output when a model reports several", () => {
    const model = normalizeModel({ model_type: "dual", main_output: ["image", "video"] })!;
    expect(model.metadata.mainOutput).toBe("image");
  });
});

/**
 * Regressions found on the first live connection to a real WanGP MCP server.
 * Each of these passed every offline test but would have broken generation.
 */
describe("live-discovered regressions", () => {
  // Real payload: LTX-2 switches between stills and motion, so WanGP reports
  // main_output ["image","video"]. Filtering on the first entry classified it
  // as an image model and hid it from video selection entirely.
  const ltx2 = normalizeModel({
    model_type: "ltx2_22B",
    name: "LTX-2 2.3 Dev 1.0 22B",
    main_output: ["image", "video"],
    outputs: ["image", "video", "audio"],
    inputs: ["text", "image", "audio"],
    media_inputs: {
      image: { start: true, end: true, reference: true },
      audio: { prompt: true, output: true },
    },
  })!;

  const pureImage = normalizeModel({
    model_type: "qwen_image",
    main_output: ["image"],
    outputs: ["image"],
    inputs: ["text"],
  })!;

  it("finds a dual-output model when selecting a video model", () => {
    expect(produces(ltx2, "video")).toBe(true);
    expect(produces(ltx2, "image")).toBe(true);
    expect(selectVideoModel([pureImage, ltx2], { modelStrategy: "auto" })?.modelType).toBe("ltx2_22B");
  });

  it("lists a dual-output model under both image and video", async () => {
    // The live client filtered listModels on mainOutput, so LTX-2 never
    // appeared in listModels("video") and could not even be pinned.
    const client = new MockWangpClient();
    const videos = await client.listModels("video");
    const images = await client.listModels("image");
    expect(videos.map((m) => m.modelType)).toContain("ltx2_22B");
    expect(images.map((m) => m.modelType)).toContain("ltx2_22B");
    expect(images.map((m) => m.modelType)).toContain("qwen_image");
  });

  it("resolves an exact model pin, and ignores an unavailable one", () => {
    const models = [pureImage, ltx2];
    expect(findPinned(models, "ltx2_22B")?.modelType).toBe("ltx2_22B");
    expect(findPinned(models, "not_installed")).toBeNull();
    expect(findPinned(models, undefined)).toBeNull();
  });

  it("still prefers a dedicated stills model for keyframes", () => {
    expect(selectImageModel([ltx2, pureImage], { modelStrategy: "auto" })?.modelType).toBe("qwen_image");
  });

  it("honours prefer_ltx over a pure image model for video", () => {
    expect(selectVideoModel([pureImage, ltx2], { modelStrategy: "prefer_ltx" })?.modelType).toBe("ltx2_22B");
  });

  // Real payload: LTX-2 19B exposes video_length but no fps field at all, and
  // 22B exposes force_fps as "". Setting video_length only inside the fps block
  // left every clip at the model default (241 frames = 10s), silently ignoring
  // the 20-second segment rule.
  const ltx19Schema = {
    modelType: "ltx2_19B",
    defaultSettings: { model_type: "ltx2_19B", prompt: "", resolution: "832x480", video_length: 241 },
    fields: [
      { name: "prompt", type: "string" },
      { name: "resolution", type: "string" },
      { name: "video_length", type: "number" },
      { name: "image_start", type: "string" },
      { name: "image_end", type: "string" },
    ],
  };

  it("sets video_length for a model that has no fps field whatsoever", () => {
    const manifest = buildSettingsManifest(ltx19Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "a lighthouse",
      fps: 24,
    });
    expect(manifest.settings.video_length).toBe(481); // 20s @ 24fps, 8-frame aligned
    expect(manifest.settings.video_length).not.toBe(241); // not the model default
    expect(manifest.settings.force_fps).toBeUndefined();
  });

  it("does not pin force_fps when the model publishes it as a non-numeric default", () => {
    const schema22 = {
      modelType: "ltx2_22B",
      defaultSettings: { model_type: "ltx2_22B", prompt: "", video_length: 361, force_fps: "" },
      fields: [
        { name: "prompt", type: "string" },
        { name: "video_length", type: "number" },
        { name: "force_fps", type: "number" },
      ],
    };
    const manifest = buildSettingsManifest(schema22, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
    });
    // force_fps "" means "model native" — overwriting it with a number is not
    // our call, but the frame count still has to reflect the segment length.
    expect(manifest.settings.force_fps).toBe("");
    expect(manifest.settings.video_length).toBe(481);
  });

  it("respects a shorter final segment when computing frame count", () => {
    const manifest = buildSettingsManifest(ltx19Schema, {
      sceneId: "s3",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 10,
    });
    expect(manifest.settings.video_length).toBe(241); // 10s @ 24fps
  });

  // Real payload: LTX-2 22B ships prompt_enhancer "T", so WanGP would rewrite
  // our prompt with its own LLM unless we explicitly turn it off.
  it("disables WanGP's prompt enhancer so crafted prompts survive", () => {
    const manifest = buildSettingsManifest(
      {
        modelType: "ltx2_22B",
        defaultSettings: { model_type: "ltx2_22B", prompt: "", prompt_enhancer: "T" },
        fields: [
          { name: "prompt", type: "string" },
          { name: "prompt_enhancer", type: "string" },
        ],
      },
      { sceneId: "s1", purpose: "video_segment", prompt: "crafted prompt" },
    );
    expect(manifest.settings.prompt_enhancer).toBe("");
    expect(manifest.settings.prompt).toBe("crafted prompt");
  });
});

describe("knownKeys", () => {
  it("merges defaults, properties, fields, setting_values and media capability flags", () => {
    const keys = knownKeys(
      {
        properties: { seed: {} },
        fields: [{ name: "sample_solver" }],
        setting_values: { resolution: { choices: ["1280x720"] } },
        metadata: { media_inputs: { image: { start: true, end: true, reference: true } } },
        model_def: { sample_solvers: ["euler"] },
      },
      { prompt: "", num_inference_steps: 8 },
    );
    for (const key of [
      "prompt",
      "num_inference_steps",
      "seed",
      "sample_solver",
      "resolution",
      "image_start",
      "image_end",
      "image_refs",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});

describe("normalizeChoices", () => {
  it("handles bare arrays, [label, value] tuples, and objects", () => {
    expect(normalizeChoices(["a", "b"])).toEqual([
      { label: "a", value: "a" },
      { label: "b", value: "b" },
    ]);
    expect(normalizeChoices([["720p", "1280x720"]])).toEqual([{ label: "720p", value: "1280x720" }]);
    expect(normalizeChoices({ choices: [{ label: "Euler", value: "euler" }] })).toEqual([
      { label: "Euler", value: "euler" },
    ]);
    expect(normalizeChoices(42)).toEqual([]);
  });

  it("de-duplicates by value", () => {
    expect(normalizeChoices(["a", "a", "b"])).toHaveLength(2);
  });
});

describe("numericRange", () => {
  it("reads published bounds from setting_values", () => {
    const range = numericRange({ setting_values: { force_fps: { min: 8, max: 50, step: 1 } } }, "force_fps");
    expect(range).toEqual({ min: 8, max: 50, step: 1 });
  });

  it("returns an empty range when nothing is published", () => {
    expect(numericRange({}, "force_fps")).toEqual({ min: undefined, max: undefined, step: undefined });
  });
});

describe("field alias resolution", () => {
  it("maps canonical names onto the installed model's real keys", () => {
    const map = resolveFieldMap(new Set(["text_prompt", "cfg_scale", "fps", "num_frames", "start_image"]));
    expect(map.prompt).toBe("text_prompt");
    expect(map.guidance_scale).toBe("cfg_scale");
    expect(map.force_fps).toBe("fps");
    expect(map.video_length).toBe("num_frames");
    expect(map.image_start).toBe("start_image");
    expect(map.image_end).toBeUndefined();
  });

  it("renames canonical settings and passes model-specific keys through", () => {
    const out = toWangpSettings(
      { prompt: "hello", force_fps: 24, embedded_guidance_scale: 6 },
      { prompt: "text_prompt", force_fps: "fps" },
    );
    expect(out).toEqual({ text_prompt: "hello", fps: 24, embedded_guidance_scale: 6 });
  });
});

describe("normalizeModelSchema", () => {
  const rawSchema = {
    setting_values: {
      resolution: { choices: ["1280x720", "1920x1080"] },
      fps: { min: 8, max: 50, step: 1 },
      sample_solver: { choices: [["Euler", "euler"]] },
    },
    metadata: { media_inputs: { image: { start: true, end: true } } },
  };
  const defaults = {
    text_prompt: "",
    negative_prompt: "",
    resolution: "1280x720",
    fps: 25,
    num_frames: 121,
    steps: 8,
    input_video_strength: 0.85,
    embedded_guidance_scale: 6,
  };

  it("renames aliased defaults to canonical names and keeps unknown defaults", () => {
    const { schema } = normalizeModelSchema("ltxv_2_distilled", rawSchema, defaults);
    expect(schema.defaultSettings.prompt).toBe("");
    expect(schema.defaultSettings.force_fps).toBe(25);
    expect(schema.defaultSettings.video_length).toBe(121);
    expect(schema.defaultSettings.num_inference_steps).toBe(8);
    expect(schema.defaultSettings.model_type).toBe("ltxv_2_distilled");
    // Not part of the canonical vocabulary -> preserved verbatim.
    expect(schema.defaultSettings.embedded_guidance_scale).toBe(6);
  });

  it("exposes discovered choices and numeric bounds on canonical fields", () => {
    const { schema } = normalizeModelSchema("ltxv_2_distilled", rawSchema, defaults);
    const byName = new Map(schema.fields.map((f) => [f.name, f]));
    expect(byName.get("resolution")!.allowed).toEqual(["1280x720", "1920x1080"]);
    expect(byName.get("force_fps")!.min).toBe(8);
    expect(byName.get("force_fps")!.max).toBe(50);
    expect(byName.get("force_fps")!.allowed).toBeUndefined();
    expect(byName.get("sample_solver")!.allowed).toEqual(["euler"]);
    expect(byName.get("image_start")).toBeDefined();
    expect(byName.get("image_end")).toBeDefined();
  });

  it("round-trips through the existing manifest builder back to real WanGP keys", () => {
    const { schema, fieldMap } = normalizeModelSchema("ltxv_2_distilled", rawSchema, defaults);
    const manifest = buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "a lighthouse at dusk",
      negativePrompt: "blurry",
      imageStart: "C:/wangp/outputs/start.png",
      imageEnd: "C:/wangp/outputs/end.png",
      fps: 24,
      resolution: "1920x1080",
    });

    // fps 24 is inside the published 8..50 range, so it is honoured, not snapped.
    expect(manifest.settings.force_fps).toBe(24);
    expect(manifest.settings.video_length).toBe(481);

    const payload = toWangpSettings(manifest.settings, fieldMap);
    expect(payload.text_prompt).toBe("a lighthouse at dusk");
    expect(payload.fps).toBe(24);
    expect(payload.num_frames).toBe(481);
    expect(payload.resolution).toBe("1920x1080");
    expect(payload.image_start).toBe("C:/wangp/outputs/start.png");
    expect(payload.image_end).toBe("C:/wangp/outputs/end.png");
    expect(payload.embedded_guidance_scale).toBe(6);
  });
});

describe("normalizeJob", () => {
  it("treats a not-started event job as submitted", () => {
    const job = normalizeJob({ job_id: "j1", done: false, events: [], result: null });
    expect(job.status).toBe("submitted");
    expect(job.progress).toBe(0);
  });

  it("reports running with the latest progress event", () => {
    const job = normalizeJob({
      job_id: "j1",
      done: false,
      events: [
        { kind: "started" },
        { kind: "progress", data: { progress: 10 } },
        { kind: "progress", data: { progress: 62 } },
      ],
      result: null,
    });
    expect(job.status).toBe("running");
    expect(job.progress).toBe(62);
  });

  it("reports running once WanGP emits progress, even without a started event", () => {
    // Observed live: WanGP streams progress but no "started" event, so a job
    // at 68% was still reporting as "submitted".
    const job = normalizeJob({
      job_id: "j1",
      done: false,
      events: [{ kind: "progress", data: { progress: 68 } }],
      result: null,
    });
    expect(job.status).toBe("running");
    expect(job.progress).toBe(68);
  });

  it("maps a successful result to completed with generated files", () => {
    const job = normalizeJob({
      job_id: "j1",
      done: true,
      events: [{ kind: "started" }],
      result: { success: true, cancelled: false, generated_files: ["C:/out/a.mp4"], errors: [] },
    });
    expect(job.status).toBe("completed");
    expect(job.progress).toBe(100);
    expect(job.generatedFiles).toEqual(["C:/out/a.mp4"]);
  });

  it("maps failure and cancellation", () => {
    expect(
      normalizeJob({
        job_id: "j1",
        done: true,
        events: [],
        result: { success: false, cancelled: false, generated_files: [], errors: [{ message: "OOM" }] },
      }),
    ).toMatchObject({ status: "failed", errors: ["OOM"] });

    expect(
      normalizeJob({
        job_id: "j1",
        done: true,
        events: [],
        result: { success: false, cancelled: true, generated_files: [], errors: [] },
      }),
    ).toMatchObject({ status: "cancelled" });
  });

  it("accepts a flat status payload and normalizes queued to submitted", () => {
    expect(normalizeJob({ id: "j2", status: "queued", progress: 0 })).toMatchObject({
      id: "j2",
      status: "submitted",
    });
  });

  it("rejects a payload with no job id", () => {
    expect(() => normalizeJob({ status: "running" })).toThrow(/job id/i);
  });
});

describe("transport result handling", () => {
  it("unwraps single-key result envelopes", () => {
    expect(unwrapStructuredContent({ result: [1, 2] })).toEqual([1, 2]);
    expect(unwrapStructuredContent({ result: 1, other: 2 })).toEqual({ result: 1, other: 2 });
  });

  it("parses JSON text content and rejects non-JSON", () => {
    expect(parseTextContent([{ type: "text", text: '{"a":1}' }])).toEqual({ a: 1 });
    expect(() => parseTextContent([{ type: "text", text: "not json" }])).toThrow(/invalid JSON/);
    expect(() => parseTextContent([])).toThrow(/no structured data/);
  });

  it("allow-lists only WanGP tools", () => {
    expect(ALLOWED_TOOLS.has("wangp_generate")).toBe(true);
    expect(ALLOWED_TOOLS.has("shell_exec")).toBe(false);
  });
});
