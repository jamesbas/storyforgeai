import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { swapFace } from "@/lib/services/face-swap-service";
import { config } from "@/lib/config";
import {
  FACE_SWAP_LORAS,
  FACE_SWAP_PROMPT,
  FACE_SWAP_STEPS,
} from "@/lib/wangp/face-swap-preset";
import type { Character } from "@/lib/schemas/character";
import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Which prompt a swap is sent with, and what must not change alongside it.
 *
 * The preset is a matched set — the head LoRA expects the Lightning schedule —
 * so a per-character prompt is allowed to change the wording and nothing else.
 */
class RecordingClient extends MockWangpClient {
  settings: Record<string, unknown> | null = null;

  async listModels(): Promise<WangpModel[]> {
    return [
      {
        modelType: config.media.faceSwapModel,
        name: "Qwen Image Edit",
        mainOutput: "image",
        outputs: ["image"],
      },
    ] as unknown as WangpModel[];
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    // Mirrors what `qwen_image_edit_plus2_20B` publishes live: `image_guide`
    // declared, and the preset's controls present as declarations or defaults.
    // A thinner fake would pass while the real request lost its LoRA stack.
    return {
      modelType,
      defaultSettings: {
        prompt: "",
        model_mode: 0,
        masking_strength: 1,
        // The real model ships this, and it is what splits a prompt on newlines.
        multi_prompts_gen_type: "PG",
      },
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

/** A character whose reference image resolves to a real file on disk. */
async function characterWithReference(overrides: Partial<Character>): Promise<Character> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-swapprompt-"));
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

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("the prompt a swap is sent with", () => {
  it("uses the character's own prompt when it has one", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapPrompt: "swap the man" });

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.prompt).toBe("swap the man");
  });

  it("falls back to the preset when the character has none", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({});

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.prompt).toBe(FACE_SWAP_PROMPT);
  });

  it("treats a whitespace-only prompt as absent", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapPrompt: "   " });

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.prompt).toBe(FACE_SWAP_PROMPT);
  });

  /**
   * The prompt is the only thing a character may override. Letting the wording
   * drag the LoRAs or the step count with it would break the recipe the swap
   * depends on.
   */
  it("leaves the LoRAs and step count alone", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapPrompt: "swap the man" });

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.num_inference_steps).toBe(FACE_SWAP_STEPS);
    expect(client.settings?.activated_loras).toEqual(FACE_SWAP_LORAS.map((lora) => lora.name));
    expect(client.settings?.loras_multipliers).toBe(
      FACE_SWAP_LORAS.map((lora) => lora.strength).join(" "),
    );
    expect(client.settings?.sample_solver).toBe("lightning");
  });

  it("sends the frame as the guide and the reference as the ref", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({});

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.image_guide).toBe("/frame.png");
    expect((client.settings?.image_refs as string[])[0]).toMatch(/ref\.png$/);
  });
  /**
   * The swap prompt is an editable textarea, and this model's saved state reads
   * a line break as a boundary between generations — four paragraphs become
   * four requests against the one task submitted. Face swap does not go through
   * `buildSettingsManifest`, which is where every other path is corrected.
   */
  it("tells the model a multi-line swap prompt is still one generation", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({
      faceSwapPrompt: "Swap the head.\n\nKeep the lighting.",
    });

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.multi_prompts_gen_type).toBe("FG");
  });

  it("does not write the setting for a single-line prompt", async () => {
    const client = new RecordingClient();
    setWangpClient(client);
    const character = await characterWithReference({ faceSwapPrompt: "Swap the head." });

    await swapFace("/frame.png", character, { sceneId: "s1", purpose: "start_frame" });

    expect(client.settings?.multi_prompts_gen_type).toBe("PG");
  });
});