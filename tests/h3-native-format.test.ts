import { describe, it, expect, afterEach, vi } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * MiniMax H3's native prompt envelope, end to end through the manifest build.
 *
 * The format module is unit-tested on its own; what this file proves is the
 * routing decision — that the envelope is applied only when the flag is on
 * *and* the model that actually resolved is H3, and that it is taken back off
 * anything else. A prompt is written for the pinned family, but a pin missing
 * from the catalogue falls through to the router, so those two can differ.
 */

/**
 * A catalogue of exactly two video models.
 *
 * Deliberately not added to `MockWangpClient`'s shared MODELS list: that list
 * drives router preference, and a new entry there changes model selection in
 * unrelated suites.
 */
class TwoModelClient extends MockWangpClient {
  constructor(private readonly only?: string) {
    super();
  }

  private static readonly CATALOG: WangpModel[] = [
    {
      modelType: "minimax_h3_fl2va",
      name: "MiniMax H3 FL2VA",
      mainOutput: "video",
      outputs: ["video", "audio"],
      metadata: { family: "minimax_h3" },
    },
    {
      modelType: "wan_i2v_14b",
      name: "Wan I2V",
      mainOutput: "video",
      outputs: ["video"],
      metadata: { family: "wan" },
    },
  ] as unknown as WangpModel[];

  async listModels(): Promise<WangpModel[]> {
    const all = TwoModelClient.CATALOG;
    return this.only ? all.filter((m) => m.modelType === this.only) : all;
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    return {
      modelType,
      defaultSettings: {
        prompt: "",
        resolution: "832x480",
        image_prompt_type: "",
        multi_prompts_gen_type: "PG",
        model_type: modelType,
      },
      fields: [
        { name: "prompt", type: "string" },
        { name: "resolution", type: "string" },
        { name: "video_length", type: "number" },
        { name: "image_start", type: "string" },
        { name: "image_end", type: "string" },
      ],
    };
  }
}

async function manifestFor(options: {
  flag: boolean;
  modelType: string;
  prompt?: string;
  soundscape?: string;
  score?: string;
}) {
  process.env.H3_NATIVE_PROMPT_FORMAT = options.flag ? "true" : "false";
  vi.resetModules();

  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(new TwoModelClient(options.modelType));
  const { buildVideoManifest } = await import("@/lib/services/wangp-service");

  return buildVideoManifest({
    sceneId: "s1",
    prompt: options.prompt ?? "She lifts the umbrella and steps beneath it.",
    modelStrategy: "auto",
    modelType: options.modelType,
    imageStart: "start.png",
    imageEnd: "end.png",
    durationSeconds: 15,
    soundscape: options.soundscape,
    score: options.score,
  });
}

afterEach(() => {
  delete process.env.H3_NATIVE_PROMPT_FORMAT;
});

describe("with the flag on and H3 resolved", () => {
  it("sends the alignment instruction and all three fields", async () => {
    const manifest = await manifestFor({
      flag: true,
      modelType: "minimax_h3_fl2va",
      soundscape: "Rain falls steadily on the pavement.",
      score: "Low strings at a slow tempo.",
    });
    const prompt = String(manifest.settings.prompt);

    expect(prompt).toMatch(/^How the reference pictures align with the target video/);
    expect(prompt).toContain("15.00-second mark");
    expect(prompt).toContain("integrated_multimodal_description: [Shot 1] She lifts the umbrella");
    expect(prompt).toContain("overall_soundscape: Rain falls steadily on the pavement.");
    expect(prompt).toContain("non_diegetic_music: Low strings at a slow tempo.");
  });

  it("writes N/A for a layer the scene never supplied", async () => {
    const manifest = await manifestFor({ flag: true, modelType: "minimax_h3_fl2va" });
    expect(String(manifest.settings.prompt)).toContain("non_diegetic_music: N/A");
  });
});

describe("with the flag off", () => {
  it("leaves H3 on plain prose", async () => {
    const manifest = await manifestFor({ flag: false, modelType: "minimax_h3_fl2va" });
    const prompt = String(manifest.settings.prompt);
    expect(prompt).not.toContain("integrated_multimodal_description");
    expect(prompt).toContain("She lifts the umbrella");
  });

  /**
   * H3's directive keeps ambience and score out of the timeline, so with the
   * envelope off those layers would reach nothing and a model that writes its
   * own soundtrack would be given no direction at all. In a live A/B the
   * unguided arm sang a line the scene had only asked it to say.
   */
  it("still delivers the audio layers, as prose", async () => {
    const manifest = await manifestFor({
      flag: false,
      modelType: "minimax_h3_fl2va",
      soundscape: "Rain falls steadily on the pavement.",
      score: "Low strings at a slow tempo.",
    });
    const prompt = String(manifest.settings.prompt);
    expect(prompt).toContain("Rain falls steadily on the pavement.");
    expect(prompt).toContain("Low strings at a slow tempo.");
    expect(prompt).not.toContain("overall_soundscape");
  });

  it("says nothing about audio the scene did not describe", async () => {
    const manifest = await manifestFor({
      flag: false,
      modelType: "minimax_h3_fl2va",
      score: "N/A",
    });
    expect(String(manifest.settings.prompt)).not.toContain("N/A");
  });

  it("does not push audio prose at a family that folds sound into the body", async () => {
    const manifest = await manifestFor({
      flag: false,
      modelType: "wan_i2v_14b",
      soundscape: "Rain falls steadily on the pavement.",
    });
    expect(String(manifest.settings.prompt)).not.toContain("Rain falls steadily");
  });
});

/**
 * H3 at 720p is slow enough that MiniMax recommend rendering at 480p and
 * upscaling, so the family is held at the draft preset. The clamp used to be
 * computed, logged, and then dropped whenever the caller passed no frame
 * options — the telemetry said "clamped to draft" and the job rendered 720p.
 */
describe("the resolution ceiling", () => {
  it("holds H3 at 480p even when the caller supplies no frame options", async () => {
    const manifest = await manifestFor({ flag: false, modelType: "minimax_h3_fl2va" });
    expect(manifest.settings.resolution).toBe("848x480");
  });

  it("leaves an uncapped family at the standard preset", async () => {
    const manifest = await manifestFor({ flag: false, modelType: "wan_i2v_14b" });
    expect(manifest.settings.resolution).toBe("1280x720");
  });
});

describe("when something other than H3 renders it", () => {
  it("never puts a Wan clip in the envelope", async () => {
    const manifest = await manifestFor({ flag: true, modelType: "wan_i2v_14b" });
    expect(String(manifest.settings.prompt)).not.toContain("integrated_multimodal_description");
  });

  /**
   * The failure this guards: a prompt written while the pin was H3, rendered
   * after the pin moved. Left alone, the labels reach a model that renders the
   * words rather than obeying them.
   */
  it("strips an envelope that arrives on a prompt bound for Wan", async () => {
    const manifest = await manifestFor({
      flag: true,
      modelType: "wan_i2v_14b",
      prompt:
        "How the reference pictures align with the target video — Picture 1 (from Shot 1) " +
        "aligns with the 0.00-second mark of the target video.\n\n" +
        "integrated_multimodal_description: [Shot 1] She lifts the umbrella.\n\n" +
        "overall_soundscape: Rain falls steadily.\n\n" +
        "non_diegetic_music: N/A",
    });
    const prompt = String(manifest.settings.prompt);

    expect(prompt).not.toContain("integrated_multimodal_description");
    expect(prompt).not.toContain("overall_soundscape");
    expect(prompt).not.toContain("N/A");
    // The direction survives even though the format does not.
    expect(prompt).toContain("She lifts the umbrella.");
    expect(prompt).toContain("Rain falls steadily.");
  });
});
