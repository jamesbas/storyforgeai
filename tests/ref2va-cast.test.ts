import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Reference mode gets its character photographs from the model, not a flag.
 *
 * `videoTier` records which variant was chosen; the family of the model a job
 * resolves to decides how that job is actually composed. They are separate
 * fields and they drift: the video model dropdown saves `videoModel` alone, and
 * an app-wide default or env pin sets it with no tier at all. While the cast
 * was gated on the tier, every one of those routes produced a Ref2VA job with
 * no character references — which renders, and reads as the model failing to
 * hold a face rather than two settings disagreeing.
 */

const dirs: string[] = [];

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-ref2va-cast-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const characters = await import("@/lib/services/character-service");
  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");
  return { characters, projects, media, MockWangpClient, setWangpClient };
}

type Env = Awaited<ReturnType<typeof isolated>>;

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A one-pixel PNG. Nothing decodes it; the path just has to exist. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const pngFile = () =>
  ({
    name: "mara.png",
    type: "image/png",
    size: PIXEL.byteLength,
    arrayBuffer: async () =>
      PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.byteLength),
  }) as unknown as File;

/** Offers a Ref2VA checkpoint for video and the ordinary catalogue for stills. */
function ref2vaClientClass(Base: Env["MockWangpClient"]) {
  const REF2VA: WangpModel = {
    modelType: "minimax_h3_ref2va",
    name: "MiniMax H3 Ref2VA",
    metadata: { mainOutput: "video", outputs: ["video"], family: "minimax_h3", qualityRank: 90 },
  } as unknown as WangpModel;

  return class extends Base {
    async listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]> {
      if (mainOutput === "video") return [REF2VA];
      const models = await super.listModels(mainOutput);
      return mainOutput ? models : [...models, REF2VA];
    }

    async getModelSchema(modelType: string): Promise<WangpModelSchema> {
      if (modelType !== REF2VA.modelType) return super.getModelSchema(modelType);
      return {
        modelType,
        defaultSettings: {
          prompt: "",
          resolution: "832x480",
          image_prompt_type: "",
          video_prompt_type: "",
        },
        fields: [
          { name: "prompt", type: "string" },
          { name: "resolution", type: "string" },
          { name: "video_length", type: "number" },
          { name: "image_refs", type: "array" },
          { name: "image_prompt_type", type: "string" },
          { name: "video_prompt_type", type: "string" },
        ],
      } as unknown as WangpModelSchema;
    }
  };
}

/**
 * Pin the Ref2VA checkpoint the way the model dropdown does — the model alone,
 * leaving `videoTier` exactly as it was.
 */
async function ref2vaProject(env: Env, tier?: "fl2va" | "ref2va") {
  const character = await env.characters.createCharacter({
    name: "Mara",
    description: "A woman in her fifties.",
    faceSwap: false,
  });
  await env.characters.setReferenceImage(character.id, pngFile());

  const project = await env.projects.createProject({
    concept: "Mara turns from the window as the rain starts.",
    requestedDurationSeconds: 40,
    useCharacterLibrary: true,
    characterIds: [character.id],
  });
  await env.projects.updateProjectModels(project.id, {
    videoModel: "minimax_h3_ref2va",
    ...(tier ? { videoTier: tier } : {}),
  });
  await env.projects.generateStoryboard(project.id);
  return env.projects.getProjectRecord(project.id);
}

/** The references sent on the one video job of a scene. */
async function videoRefs(env: Env, record: Awaited<ReturnType<typeof ref2vaProject>>) {
  const Client = ref2vaClientClass(env.MockWangpClient);
  const client = new Client();
  const submitted = vi.spyOn(client, "generate");
  env.setWangpClient(client);

  await env.media.generateSceneMedia(record.project.id, record.storyboard!.scenes[0]!.id);

  const video = submitted.mock.calls
    .map(([settings]) => settings as Record<string, unknown>)
    .find((settings) => settings.model_type === "minimax_h3_ref2va" || "video_length" in settings);
  return {
    refs: Array.isArray(video?.image_refs) ? (video!.image_refs as string[]) : [],
    prompt: String(video?.prompt ?? ""),
  };
}

describe("reference mode and the character photographs", () => {
  it("sends them when the tier says so", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "ref2va");

    const { refs, prompt } = await videoRefs(env, record);

    // Start frame, end frame, then one photograph per character (FR-3 order).
    expect(refs).toHaveLength(3);
    expect(refs.at(-1)).toContain("character-images");
    expect(prompt).toContain("Mara");
  });

  it("sends them for a Ref2VA model pinned without the tier ever being set", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env);

    // Exactly the state the model dropdown, an app-wide default or an env pin
    // leaves behind, and the one that used to send no photograph at all.
    expect(record.project.videoTier).toBeUndefined();

    const { refs, prompt } = await videoRefs(env, record);
    expect(refs).toHaveLength(3);
    expect(refs.at(-1)).toContain("character-images");
    expect(prompt).toContain("Mara");
  });

  it("sends them even when the tier flatly contradicts the model", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "fl2va");

    const { refs } = await videoRefs(env, record);
    expect(refs).toHaveLength(3);
  });

  it("still sends none when reference photographs are turned off", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "ref2va");
    await env.projects.updateProjectModels(record.project.id, {
      useCharacterReferenceImages: false,
    });
    const updated = await env.projects.getProjectRecord(record.project.id);

    const { refs } = await videoRefs(env, updated);
    // The two anchors survive: they are the composition, not an identity.
    expect(refs).toHaveLength(2);
    expect(refs.some((ref) => ref.includes("character-images"))).toBe(false);
  });
});
