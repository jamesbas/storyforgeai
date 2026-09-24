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

  /**
   * The keyframe switch used to govern this too, so choosing
   * description-and-face-swap for the stills silently took the character
   * photographs off the clip as well — leaving a reference-mode render taking
   * identity from its start frame, which is the dependency the family exists to
   * escape. The two mechanisms differ: an image model gets a bare `image_refs`
   * list and can smear a likeness across everyone in frame, while these are
   * named subjects bound to one person in the prose.
   */
  it("keeps sending them when only the keyframe photographs are turned off", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "ref2va");
    await env.projects.updateProjectModels(record.project.id, {
      useCharacterReferenceImages: false,
    });
    const updated = await env.projects.getProjectRecord(record.project.id);

    const { refs, prompt } = await videoRefs(env, updated);
    expect(refs).toHaveLength(3);
    expect(refs.at(-1)).toContain("character-images");
    expect(prompt).toContain("Mara");
  });

  it("sends none when the video photographs are turned off", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "ref2va");
    await env.projects.updateProjectModels(record.project.id, {
      videoCharacterReferences: false,
    });
    const updated = await env.projects.getProjectRecord(record.project.id);

    const { refs } = await videoRefs(env, updated);
    // The two anchors survive: they are the composition, not an identity.
    expect(refs).toHaveLength(2);
    expect(refs.some((ref) => ref.includes("character-images"))).toBe(false);
  });

  /** A project that never chose gets the lock its model choice implies. */
  it("sends them by default, with neither switch set", async () => {
    const env = await isolated();
    const record = await ref2vaProject(env, "ref2va");
    expect(record.project.videoCharacterReferences).toBeUndefined();

    const { refs } = await videoRefs(env, record);
    expect(refs).toHaveLength(3);
  });
});

/**
 * More than one photograph of the same face.
 *
 * Every path took `referenceImagesOf(character)[0]` and read the rest of the
 * library only as a has-a-photo test, so three of a character's four stored
 * images were dead weight. That is right for an *edit* model — four photographs
 * of one woman rendered her twice in the same shot — but a reference-to-video
 * model conditions identity across a whole clip and is the one place more
 * angles plausibly help. Opt-in, because the cost is about seven minutes of
 * render per added image, paid on every clip.
 */
describe("more than one photograph per character", () => {
  async function twoPhotos(env: Env, perCharacter?: number) {
    const character = await env.characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
      faceSwap: false,
    });
    await env.characters.setReferenceImage(character.id, pngFile());
    await env.characters.setReferenceImage(character.id, pngFile());

    const project = await env.projects.createProject({
      concept: "Mara turns from the window as the rain starts.",
      requestedDurationSeconds: 40,
      useCharacterLibrary: true,
      characterIds: [character.id],
    });
    await env.projects.updateProjectModels(project.id, {
      videoModel: "minimax_h3_ref2va",
      ...(perCharacter === undefined ? {} : { videoReferencesPerCharacter: perCharacter }),
    });
    await env.projects.generateStoryboard(project.id);
    return env.projects.getProjectRecord(project.id);
  }

  it("still sends one when nothing asked for more", async () => {
    const env = await isolated();
    const record = await twoPhotos(env);

    const { refs } = await videoRefs(env, record);
    // Two anchors, one photograph — the stored second is not volunteered.
    expect(refs).toHaveLength(3);
  });

  it("sends both when the project asks for two", async () => {
    const env = await isolated();
    const record = await twoPhotos(env, 2);

    const { refs } = await videoRefs(env, record);
    expect(refs).toHaveLength(4);
    expect(refs.filter((ref) => ref.includes("character-images"))).toHaveLength(2);
  });

  /**
   * The failure this guards: an unexplained second photograph of a character
   * reads as a second character, and the binding is what keeps one likeness off
   * two bodies.
   */
  it("tells the model the extra picture is the same person", async () => {
    const env = await isolated();
    const record = await twoPhotos(env, 2);

    const { prompt } = await videoRefs(env, record);
    expect(prompt).toContain("<Picture 3>");
    expect(prompt).toContain("<Picture 4>");
    expect(prompt).toContain("the same person from different angles");
  });

  it("sends what the character has when asked for more than exist", async () => {
    const env = await isolated();
    const record = await twoPhotos(env, 4);

    const { refs } = await videoRefs(env, record);
    // Two stored, four requested: two sent, and no empty slot in the list.
    expect(refs).toHaveLength(4);
    expect(refs.every((ref) => ref.length > 0)).toBe(true);
  });
});
