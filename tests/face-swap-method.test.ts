import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { swapFace } from "@/lib/services/face-swap-service";
import { config } from "@/lib/config";
import { faceSwapMethodOf, faceSwapPromptOf, faceSwapStepsOf } from "@/lib/schemas/character";
import {
  DEFAULT_FACE_SWAP_METHOD,
  FACE_SWAP_STEPS,
  faceSwapPresetFor,
  faceSwapPromptFor,
  faceSwapTaskFlagsFor,
  isDefaultFaceSwapPrompt,
  QWEN_FACE_SWAP_SETTINGS,
  type FaceSwapMethod,
} from "@/lib/wangp/face-swap-preset";
import type { Character } from "@/lib/schemas/character";
import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Which engine a character's swap runs on.
 *
 * Two very different recipes now sit behind one checkbox, and the thing that
 * separates them is not just a model id: the Qwen preset carries
 * Qwen-architecture LoRAs, and Krea publishes `activated_loras` too, so a
 * filter that asks only "does this model have the field" would hand them over
 * quite happily.
 */
class RecordingClient extends MockWangpClient {
  settings: Record<string, unknown> | null = null;

  constructor(private readonly installed: string[]) {
    super();
  }

  async listModels(): Promise<WangpModel[]> {
    return this.installed.map((modelType) => ({
      modelType,
      name: modelType,
      mainOutput: "image",
      outputs: ["image"],
    })) as unknown as WangpModel[];
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    // Mirrors what `krea2_turbo_edit` publishes live on server 1.10.1: no
    // `image_guide`, no CFG, no solver, no mask controls — but LoRA slots that
    // would accept the Qwen stack without complaint.
    if (modelType === config.media.faceSwapModels.krea) {
      return {
        modelType,
        defaultSettings: {
          prompt: "",
          video_prompt_type: "KI",
          multi_prompts_gen_type: "PG",
          remove_background_images_ref: 0,
          num_inference_steps: 8,
          // Saved UI state from another application, which is how WanGP serves
          // its defaults and why an empty stack has to be asserted.
          activated_loras: ["someone_elses_choice.safetensors"],
          loras_multipliers: "1.0",
        },
        fields: [
          { name: "prompt", type: "string" },
          { name: "negative_prompt", type: "string" },
          { name: "resolution", type: "string" },
          { name: "num_inference_steps", type: "number" },
          { name: "image_refs", type: "string" },
          { name: "video_prompt_type", type: "string" },
          { name: "activated_loras", type: "string" },
          { name: "loras_multipliers", type: "string" },
        ],
      };
    }

    return {
      modelType,
      defaultSettings: { prompt: "", model_mode: 0, masking_strength: 1, multi_prompts_gen_type: "PG" },
      fields: [
        { name: "prompt", type: "string" },
        { name: "image_guide", type: "string" },
        { name: "num_inference_steps", type: "number" },
        { name: "guidance_scale", type: "number" },
        { name: "sample_solver", type: "string" },
        { name: "activated_loras", type: "string" },
        { name: "loras_multipliers", type: "string" },
      ],
    };
  }

  async generate(settings: Record<string, unknown>): Promise<WangpJob> {
    this.settings = settings;
    return { id: "job-1", status: "submitted", progress: 0, generatedFiles: [], errors: [] };
  }

  async getJob(jobId: string): Promise<WangpJob> {
    return {
      id: jobId,
      status: "completed",
      progress: 100,
      generatedFiles: ["/swapped.png"],
      errors: [],
    };
  }
}

const dirs: string[] = [];

async function characterWithReference(overrides: Partial<Character>): Promise<Character> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-swapmethod-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;

  const library = path.join(dir, "library", "characters");
  await fs.mkdir(library, { recursive: true });
  await fs.writeFile(path.join(library, "ref.png"), Buffer.from([1, 2, 3]));

  return {
    id: "c1",
    name: "Lead",
    description: "A person.",
    referenceImages: ["ref.png"],
    faceSwap: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const BOTH = [config.media.faceSwapModels.krea, config.media.faceSwapModels.qwen];

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("choosing the engine", () => {
  it("uses Krea for a character that has never been given a method", () => {
    // Covers every character saved before the setting existed.
    expect(faceSwapMethodOf({})).toBe("krea");
    expect(DEFAULT_FACE_SWAP_METHOD).toBe("krea");
  });

  it("honours an explicit choice", () => {
    expect(faceSwapMethodOf({ faceSwapMethod: "qwen" })).toBe("qwen");
    expect(faceSwapMethodOf({ faceSwapMethod: "krea" })).toBe("krea");
  });

  it("sends the character's choice to the matching checkpoint", async () => {
    for (const method of ["krea", "qwen"] as FaceSwapMethod[]) {
      const client = new RecordingClient(BOTH);
      setWangpClient(client);
      const character = await characterWithReference({ faceSwapMethod: method });

      await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

      expect(client.settings?.model_type).toBe(config.media.faceSwapModels[method]);
    }
  });

  /**
   * Not falling back to the other engine. They produce visibly different faces,
   * so a silent substitution would read as the character changing appearance
   * for no stated reason — the frame keeps its original head instead.
   */
  it("skips rather than substituting when the chosen model is not installed", async () => {
    const client = new RecordingClient([config.media.faceSwapModels.qwen]);
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapMethod: "krea" });

    const result = await swapFace("/frame.png", character, {
      sceneId: "s1",
      purpose: "start_frame",
    });

    expect(result).toBeNull();
    expect(client.settings).toBeNull();
  });
});

describe("the Krea identity-edit path", () => {
  async function kreaSwap(overrides: Partial<Character> = {}) {
    const client = new RecordingClient(BOTH);
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapMethod: "krea", ...overrides });
    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });
    return client;
  }

  it("passes the frame first and the reference face second", async () => {
    const client = await kreaSwap();

    // Krea publishes no `image_guide`, so both images travel as an ordered
    // pair and the order is the whole meaning.
    expect(client.settings).not.toHaveProperty("image_guide");
    const refs = client.settings?.image_refs as string[];
    expect(refs[0]).toBe("/frame.png");
    expect(refs[1]).toMatch(/ref\.png$/);
    expect(client.settings?.video_prompt_type).toBe("KI");
  });

  /**
   * Each engine keeps its own wording, so switching does not drag the other
   * one's phrasing along — Qwen's transplant instruction measurably underperforms
   * on Krea.
   */
  it("uses the wording saved for this engine", async () => {
    expect((await kreaSwap()).settings?.prompt).toBe(faceSwapPromptFor("krea", "woman"));
    expect(
      (await kreaSwap({ faceSwapPrompts: { krea: "change her face", qwen: "head_swap: ..." } }))
        .settings?.prompt,
    ).toBe("change her face");
  });

  it("names a man a man in both defaults", async () => {
    const client = await kreaSwap({ faceSwapSubject: "man" });
    expect(client.settings?.prompt).toBe(faceSwapPromptFor("krea", "man"));
    expect(client.settings?.prompt).toContain("the man's face");
    expect(faceSwapPromptFor("qwen", "man")).toContain("the head of only the man");
  });

  /**
   * A prompt tuned for Qwen before the split stays Qwen's. Krea starts from its
   * own default rather than inheriting phrasing it does worse with.
   */
  it("does not hand a pre-split prompt to Krea", async () => {
    const client = await kreaSwap({ faceSwapPrompt: "head_swap: start with Picture 1" });
    expect(client.settings?.prompt).toBe(faceSwapPromptFor("krea", "woman"));
  });

  /**
   * The one thing the Krea preset asserts rather than omits.
   *
   * Krea declares `activated_loras`, so the Qwen stack would pass the "does the
   * model publish this field" filter — a Qwen accelerator and head LoRA loaded
   * onto a Krea checkpoint. Omitting them is not enough either, because WanGP
   * serves saved UI state as defaults.
   */
  it("runs bare, with no LoRAs of anyone's", async () => {
    const client = await kreaSwap();

    expect(client.settings?.activated_loras).toEqual([]);
    expect(client.settings?.loras_multipliers).toBe("");
    expect(JSON.stringify(client.settings)).not.toContain("bfs_head");
    expect(JSON.stringify(client.settings)).not.toContain("someone_elses_choice");
  });

  /**
   * Krea is already distilled and publishes none of these. The Qwen numbers are
   * tuned to a Lightning schedule that is not running here, so borrowing them
   * would be a guess dressed as a setting.
   */
  it("does not borrow the Qwen schedule or guidance", async () => {
    const client = await kreaSwap();

    expect(client.settings).not.toHaveProperty("guidance_scale");
    expect(client.settings).not.toHaveProperty("sample_solver");
    expect(client.settings).not.toHaveProperty("masking_strength");
    expect(client.settings?.num_inference_steps).toBe(8);
  });

  it("keeps a multi-line prompt as one generation", async () => {
    const client = await kreaSwap({
      faceSwapPrompts: { krea: "Swap the head.\n\nKeep the lighting." },
    });
    expect(client.settings?.multi_prompts_gen_type).toBe("FG");
  });
});

describe("the two presets", () => {
  it("are not the same object", () => {
    expect(faceSwapPresetFor("qwen")).toBe(QWEN_FACE_SWAP_SETTINGS);
    expect(faceSwapPresetFor("krea")).not.toBe(QWEN_FACE_SWAP_SETTINGS);
  });

  it("point at different checkpoints", () => {
    expect(config.media.faceSwapModels.krea).not.toBe(config.media.faceSwapModels.qwen);
    expect(config.media.faceSwapModels.krea).toMatch(/krea/);
    expect(config.media.faceSwapModels.qwen).toMatch(/qwen/);
  });
});

/**
 * Each engine keeps its own wording, so switching back and forth is a click
 * rather than a rewrite and neither version is lost.
 */
describe("wording, per engine", () => {  it("addresses each engine in its own terms", () => {
    const krea = faceSwapPromptFor("krea", "woman");
    const qwen = faceSwapPromptFor("qwen", "woman");

    expect(krea).toContain("the first image");
    expect(krea).toContain("2nd reference image");
    expect(krea).not.toContain("Picture 1");

    expect(qwen).toContain("Picture 1");
    expect(qwen).toContain("Picture 2");
    expect(qwen).not.toContain("the first image");
  });

  it("names the subject throughout, so a man is never called a woman", () => {
    for (const method of ["krea", "qwen"] as FaceSwapMethod[]) {
      expect(faceSwapPromptFor(method, "man")).not.toMatch(/\bwoman\b/);
      expect(faceSwapPromptFor(method, "woman")).not.toMatch(/\bman\b/);
    }
  });

  it("keeps one side's edit off the other side", () => {
    const character = { faceSwapPrompts: { krea: "mine for krea" } };
    expect(faceSwapPromptOf(character, "krea")).toBe("mine for krea");
    expect(faceSwapPromptOf(character, "qwen")).toBe(faceSwapPromptFor("qwen", "woman"));
  });

  it("recognises a default so the subject picker knows what is safe to rewrite", () => {
    expect(isDefaultFaceSwapPrompt(faceSwapPromptFor("qwen", "man"))).toBe(true);
    expect(isDefaultFaceSwapPrompt(faceSwapPromptFor("krea", "woman"))).toBe(true);
    expect(isDefaultFaceSwapPrompt("   ")).toBe(true);
    expect(isDefaultFaceSwapPrompt("something I wrote")).toBe(false);
  });
});

/**
 * Step count, the one Krea parameter Wan2GP actually exposes. Its contract
 * publishes no guidance, solver, mask or reference-boost control at all, so
 * this and the prompt are the whole tuning surface.
 */describe("step count, per engine", () => {
  async function swapWith(overrides: Partial<Character>) {
    const client = new RecordingClient(BOTH);
    setWangpClient(client);
    const character = await characterWithReference(overrides);
    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });
    return client;
  }

  it("leaves each engine on its own default when nothing is set", async () => {
    // Krea's own published default, which the app does not send.
    expect((await swapWith({ faceSwapMethod: "krea" })).settings?.num_inference_steps).toBe(8);
    // Qwen's preset number, matched to the Lightning schedule.
    expect((await swapWith({ faceSwapMethod: "qwen" })).settings?.num_inference_steps).toBe(
      FACE_SWAP_STEPS,
    );
  });

  it("sends a hand-set count", async () => {
    const client = await swapWith({ faceSwapMethod: "krea", faceSwapSteps: { krea: 10 } });
    expect(client.settings?.num_inference_steps).toBe(10);
  });

  /**
   * The reason this is stored per engine. Qwen's 4 is not a free number, so a
   * count that suited Krea following the character across would silently run
   * the head LoRA off the schedule it expects.
   */
  it("does not let one engine's count reach the other", async () => {
    const client = await swapWith({ faceSwapMethod: "qwen", faceSwapSteps: { krea: 10 } });
    expect(client.settings?.num_inference_steps).toBe(FACE_SWAP_STEPS);
  });

  it("reads a hand-set count back per engine", () => {
    const character = { faceSwapSteps: { krea: 10 } };
    expect(faceSwapStepsOf(character, "krea")).toBe(10);
    expect(faceSwapStepsOf(character, "qwen")).toBeUndefined();
    expect(faceSwapStepsOf({}, "krea")).toBeUndefined();
  });
});

/**
 * `image_mode` describes the request rather than the model, so no schema
 * publishes it and the field filter must not reach it.
 *
 * Filtering it away silently broke every Qwen swap: that definition also
 * declares `video_length` and `force_fps`, so without the flag WanGP read the
 * job as video and failed it with "You must provide a Control Video" — the
 * frame arrived as a control video that was never supplied. Verified live on
 * server 1.10.1, which completed the identical job the moment the flag was put
 * back.
 */
describe("flags that describe the request rather than the model", () => {
  async function swapWith(method: FaceSwapMethod) {
    const client = new RecordingClient(BOTH);
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapMethod: method });
    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });
    return client;
  }

  it("sends image_mode to Qwen even though it publishes no such field", async () => {
    const client = await swapWith("qwen");
    expect(client.settings?.image_mode).toBe(1);
  });

  /** The other two the same filter stripped out of the proven recipe. */
  it("restores the reference compositing values with it", async () => {
    const client = await swapWith("qwen");
    expect(client.settings?.remove_background_images_ref).toBe(1);
    expect(client.settings?.image_refs_relative_size).toBe(50);
  });

  it("leaves Krea without them, since it composites references differently", async () => {
    const client = await swapWith("krea");
    expect(client.settings).not.toHaveProperty("image_mode");
    expect(client.settings).not.toHaveProperty("image_refs_relative_size");
  });

  /** They are not tunables, so they must not sit in the filtered preset. */
  it("keeps them out of the settings the filter governs", () => {
    expect(QWEN_FACE_SWAP_SETTINGS).not.toHaveProperty("image_mode");
    expect(QWEN_FACE_SWAP_SETTINGS).not.toHaveProperty("remove_background_images_ref");
    expect(faceSwapTaskFlagsFor("qwen").image_mode).toBe(1);
  });
});
