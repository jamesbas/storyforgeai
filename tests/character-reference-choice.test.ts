import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Opting out of reference photographs.
 *
 * A photograph conditions the whole frame rather than one figure in it, so on a
 * shot with several people the model applies the likeness to more than one of
 * them — a woman's face arriving on the men beside her. Turning it off has to
 * actually stop the photo being sent, and with it the constraint that the image
 * model must accept references at all.
 */

const dirs: string[] = [];

/**
 * The character library is one JSON file under the data dir, rewritten whole on
 * every change, so this file works in a directory of its own.
 */
async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-refchoice-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const characters = await import("@/lib/services/character-service");
  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");

  setWangpClient(new MockWangpClient());
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

/** The node test environment's File has no arrayBuffer, so duck-type one. */
const pngFile = () =>
  ({
    name: "mara.png",
    type: "image/png",
    size: PIXEL.byteLength,
    arrayBuffer: async () =>
      PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.byteLength),
  }) as unknown as File;

async function pokerProject(env: Env, useRefs: boolean) {
  const character = await env.characters.createCharacter({
    name: "Mara",
    description: "A woman in her fifties.",
    faceSwap: true,
  });
  await env.characters.setReferenceImage(character.id, pngFile());

  const project = await env.projects.createProject({
    concept: "Four men play poker while Mara watches from the doorway.",
    requestedDurationSeconds: 40,
    useCharacterLibrary: true,
    characterIds: [character.id],
  });
  await env.projects.updateProjectModels(project.id, { useCharacterReferenceImages: useRefs });
  await env.projects.generateStoryboard(project.id);
  return env.projects.getProjectRecord(project.id);
}

/** Every reference path sent on the image jobs of one scene. */
async function refsSent(env: Env, record: Awaited<ReturnType<typeof pokerProject>>) {
  const client = new env.MockWangpClient();
  const submitted = vi.spyOn(client, "generate");
  env.setWangpClient(client);

  await env.media.generateSceneMedia(record.project.id, record.storyboard!.scenes[0]!.id);

  return submitted.mock.calls.flatMap(([settings]) => {
    const refs = (settings as Record<string, unknown>)?.image_refs;
    return Array.isArray(refs) ? (refs as string[]) : [];
  });
}

describe("choosing how a likeness reaches the frame", () => {
  it("stores the choice and leaves it editable", async () => {
    const env = await isolated();
    const record = await pokerProject(env, false);
    expect(record.project.useCharacterReferenceImages).toBe(false);

    await env.projects.updateProjectModels(record.project.id, {
      useCharacterReferenceImages: true,
    });
    const back = await env.projects.getProjectRecord(record.project.id);
    expect(back.project.useCharacterReferenceImages).toBe(true);
  });

  /** Absent means the behaviour every project had before the choice existed. */
  it("defaults to sending the photograph", async () => {
    const env = await isolated();
    const project = await env.projects.createProject({
      concept: "A quiet street.",
      requestedDurationSeconds: 20,
    });
    const record = await env.projects.getProjectRecord(project.id);
    expect(record.project.useCharacterReferenceImages).toBeUndefined();
  });

  /**
   * The point of the setting: with it off, nothing of hers reaches the frame to
   * bleed onto the people beside her. Compared rather than matched by filename,
   * because a scene frame is also a reference and only the count separates them
   * reliably.
   */
  it("stops sending the photograph when the choice is off", async () => {
    const withRefs = await isolated();
    const on = await refsSent(withRefs, await pokerProject(withRefs, true));
    expect(on.length).toBeGreaterThan(0);

    const without = await isolated();
    const off = await refsSent(without, await pokerProject(without, false));
    expect(off.length).toBeLessThan(on.length);
  });

  /**
   * A photograph outranks the prompt, so one belonging to someone the shot
   * frames out is the strongest instruction in the job to put them in it — and
   * it arrives wearing their clothes. Presence was read from the scene card,
   * which routinely disagrees with a frame: a watcher the card seats in the
   * corner chair is one a close two-shot leaves out.
   */
  it("withholds a photograph from a frame that does not show them", async () => {
    const env = await isolated();

    const mara = await env.characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
    });
    await env.characters.setReferenceImage(mara.id, pngFile());
    const dane = await env.characters.createCharacter({
      name: "Dane",
      description: "A man in his fifties, in a white polo shirt.",
    });
    await env.characters.setReferenceImage(dane.id, pngFile());

    const project = await env.projects.createProject({
      concept: "Mara and Dane share a hotel suite.",
      requestedDurationSeconds: 20,
      useCharacterLibrary: true,
      characterIds: [mara.id, dane.id],
    });
    const built = await env.projects.generateStoryboard(project.id);
    const scene = built.storyboard!.scenes[0]!;

    // The card holds both; only the end frame frames Dane.
    await env.projects.updateSceneCard(project.id, scene.id, {
      visualDescription: "Mara stands by the door. Dane waits in a corner chair.",
      actionDescription: "Mara looks toward Dane.",
    });
    await env.projects.updateScenePrompts(project.id, scene.id, {
      startFramePrompt: "Close on Mara alone at the door. Exactly one person is in frame.",
      endFramePrompt: "Dane rises from the corner chair as Mara turns to look at him.",
    });

    const client = new env.MockWangpClient();
    const submitted = vi.spyOn(client, "generate");
    env.setWangpClient(client);
    await env.media.generateSceneMedia(project.id, scene.id);

    const danePhoto = (await env.characters.getCharacter(dane.id)).referenceImages![0]!;
    const refsFor = (needle: string) =>
      submitted.mock.calls
        .filter(([settings]) => String((settings as Record<string, unknown>).prompt ?? "").includes(needle))
        .flatMap(([settings]) => ((settings as Record<string, unknown>).image_refs as string[]) ?? []);

    expect(refsFor("alone at the door").some((p) => p.includes(danePhoto))).toBe(false);
    expect(refsFor("rises from the corner chair").some((p) => p.includes(danePhoto))).toBe(true);
  });

  /**
   * Nothing in the job says which reference is which person, so with two the
   * binding between photograph, name and stated wardrobe collapses: a
   * husband's portrait and a wife's on the same job produced her likeness in
   * his chair and his shirt on a third man who was meant to be naked. One
   * photograph gives the model no choice to get wrong, and the face swap
   * recovers the rest one person at a time.
   */
  it("sends at most one photograph even when two characters are in the frame", async () => {
    const env = await isolated();

    const mara = await env.characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
    });
    await env.characters.setReferenceImage(mara.id, pngFile());
    const dane = await env.characters.createCharacter({
      name: "Dane",
      description: "A man in his fifties.",
    });
    await env.characters.setReferenceImage(dane.id, pngFile());

    const project = await env.projects.createProject({
      concept: "Mara and Dane share a hotel suite.",
      requestedDurationSeconds: 20,
      useCharacterLibrary: true,
      characterIds: [mara.id, dane.id],
    });
    const built = await env.projects.generateStoryboard(project.id);
    const scene = built.storyboard!.scenes[0]!;

    await env.projects.updateSceneCard(project.id, scene.id, {
      visualDescription: "Mara and Dane stand together by the window.",
      actionDescription: "They look out at the street.",
    });
    await env.projects.updateScenePrompts(project.id, scene.id, {
      startFramePrompt: "Wide shot. Mara stands beside Dane at the window.",
      endFramePrompt: "Wide shot. Mara leans on Dane at the window.",
    });

    const client = new env.MockWangpClient();
    const submitted = vi.spyOn(client, "generate");
    env.setWangpClient(client);
    await env.media.generateSceneMedia(project.id, scene.id);

    const photos = [
      (await env.characters.getCharacter(mara.id)).referenceImages![0]!,
      (await env.characters.getCharacter(dane.id)).referenceImages![0]!,
    ];
    for (const [settings] of submitted.mock.calls) {
      const refs = ((settings as Record<string, unknown>).image_refs as string[]) ?? [];
      const portraits = refs.filter((p) => photos.some((f) => p.includes(f)));
      expect(portraits.length).toBeLessThanOrEqual(1);
    }
  });

  it("sends one photograph on a single-reference model however many are stored", async () => {
    const env = await isolated();

    const mara = await env.characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
    });
    await env.characters.setReferenceImage(mara.id, pngFile());
    await env.characters.setReferenceImage(mara.id, pngFile());
    await env.characters.setReferenceImage(mara.id, pngFile());
    const stored = await env.characters.getCharacter(mara.id);
    expect(stored.referenceImages!.length).toBe(3);

    const project = await env.projects.createProject({
      concept: "Mara waits alone in a hotel suite.",
      requestedDurationSeconds: 20,
      useCharacterLibrary: true,
      characterIds: [mara.id],
    });
    const built = await env.projects.generateStoryboard(project.id);

    const client = new env.MockWangpClient();
    const submitted = vi.spyOn(client, "generate");
    env.setWangpClient(client);
    await env.media.generateSceneMedia(project.id, built.storyboard!.scenes[0]!.id);

    for (const [settings] of submitted.mock.calls) {
      const refs = ((settings as Record<string, unknown>).image_refs as string[]) ?? [];
      const hers = refs.filter((p) => stored.referenceImages!.some((f) => p.includes(f)));
      expect(hers.length).toBeLessThanOrEqual(1);
    }
  });
});

function recordingModelClient(env: Env, model: WangpModel, maxItems?: number) {
  return new class extends env.MockWangpClient {
    readonly calls: Record<string, unknown>[] = [];
    async listModels(output?: "image" | "video" | "audio") {
      const models = await super.listModels(output);
      return !output || output === "image" ? [model, ...models] : models;
    }
    async getModelSchema(type: string): Promise<WangpModelSchema> {
      if (type !== model.modelType) return super.getModelSchema(type);
      return {
        modelType: type,
        defaultSettings: { model_type: type, resolution: "1280x720", num_inference_steps: 20, seed: -1 },
        fields: [
          { name: "prompt", type: "string" },
          { name: "negative_prompt", type: "string" },
          { name: "resolution", type: "string" },
          { name: "num_inference_steps", type: "number" },
          { name: "seed", type: "number" },
          ...(model.metadata.mediaInputs?.image?.reference ? [
            { name: "image_refs", type: "array", ...(maxItems === undefined ? {} : { maxItems }) },
            { name: "video_prompt_type", type: "string" },
          ] : []),
        ],
      };
    }
    async generate(settings: Record<string, unknown>) {
      this.calls.push(settings);
      return super.generate(settings);
    }
  }();
}

async function fourPhotoProject(modelType: string, options: { maxItems?: number; maxReferences?: number; noReferences?: boolean } = {}) {
  const env = await isolated();
  const client = recordingModelClient(env, {
    modelType, name: modelType,
    metadata: {
      mainOutput: "image", inputs: ["text", "image"], availability: "available",
      mediaInputs: { image: {
        reference: !options.noReferences, multipleReferences: true,
        ...(options.maxReferences === undefined ? {} : { maxReferences: options.maxReferences }),
      } },
    },
  }, options.maxItems);
  env.setWangpClient(client);
  const mara = await env.characters.createCharacter({ name: "Mara", description: "A woman with brown hair." });
  for (let i = 0; i < 4; i++) await env.characters.setReferenceImage(mara.id, pngFile());
  const photoNames = (await env.characters.getCharacter(mara.id)).referenceImages!;
  const project = await env.projects.createProject({
    concept: "Mara sits at a wooden table and sets down a cup.",
    requestedDurationSeconds: 40, generationMode: "keyframes_only", sceneContinuity: "reuse_end_frame",
    useCharacterLibrary: true, characterIds: [mara.id], imageModel: modelType,
  });
  const record = await env.projects.generateStoryboard(project.id);
  const ids = record.storyboard!.scenes.map((scene) => scene.id);
  for (const id of ids) {
    await env.projects.updateScenePrompts(project.id, id, {
      startFramePrompt: "Medium shot, eye level. Mara sits at the table holding a cup. Exactly one woman is in frame.",
      endFramePrompt: "Medium shot, eye level. Mara sits at the table with the cup on the table. Exactly one woman is in frame.",
      ...(id === ids[1] ? {
        endFrameEditPrompt: "Edit the supplied reference frame: set Mara's cup on the table. Keep her face, hair and outfit unchanged. Exactly one woman is in frame.",
      } : {}),
    });
  }
  return { env, client, project, ids, photoNames };
}

function references(settings: Record<string, unknown>): string[] {
  return Array.isArray(settings.image_refs)
    ? settings.image_refs.filter((ref): ref is string => typeof ref === "string")
    : [];
}

describe("model-aware keyframe photo counts", () => {
  it.each([
    ["qwen_image_21_7B", 4, 4],
    ["qwen_image_21_turbo_7B", 4, 4],
    ["krea2_turbo_identity_edit_v2", 2, 1],
    ["fibo2_dev", 4, 3],
  ] as const)("reserves the carried frame and fits saved photos on %s in a batch", async (type, creationPhotos, carriedPhotos) => {
    const { env, client, project, ids, photoNames } = await fourPhotoProject(type);
    await env.media.generateProjectMediaPhased(project.id, ids);
    expect(references(client.calls[0]!).map((ref) => path.basename(ref))).toEqual(photoNames.slice(0, creationPhotos));
    const record = await env.projects.getProjectRecord(project.id);
    const source = record.attempts![ids[0]!]![0]!.endImagePath;
    const last = client.calls.at(-1)!;
    expect(references(last)).toHaveLength(1 + carriedPhotos);
    expect(references(last)[0]).toBe(source);
    expect(references(last).slice(1).map((ref) => path.basename(ref))).toEqual(photoNames.slice(0, carriedPhotos));
    expect(last.video_prompt_type).toBe(type === "fibo2_dev" ? "I" : "KI");
    if (carriedPhotos > 1) expect(String(last.prompt)).toContain(`${carriedPhotos} character reference photographs show the same person, Mara`);

    const previews = await env.media.previewSceneRenders(project.id);
    const settings = previews.find((frame) => frame.sceneId === ids[1] && frame.purpose === "end_frame")!.settings!;
    expect(references(settings)).toEqual(references(last));
  });

  it("uses all four photos alongside the source on individual renders and keyframe previews", async () => {
    const { env, client, project, ids, photoNames } = await fourPhotoProject("qwen_image_21_7B");
    await env.media.generateSceneMedia(project.id, ids[0]!);
    await env.media.generateSceneMedia(project.id, ids[1]!);
    const source = (await env.projects.getProjectRecord(project.id)).attempts![ids[1]!]![0]!.startImagePath;
    expect(references(client.calls.at(-1)!)[0]).toBe(source);
    expect(references(client.calls.at(-1)!).slice(1).map((ref) => path.basename(ref))).toEqual(photoNames);
    client.calls.length = 0;
    await env.media.generateSceneKeyframe(project.id, ids[1]!, "end_frame");
    expect(references(client.calls[0]!)[0]).toBe(source);
    expect(references(client.calls[0]!).slice(1).map((ref) => path.basename(ref))).toEqual(photoNames);
  });

  it("honours schema capacity even when catalogue metadata advertises more", async () => {
    const { env, client, project, ids, photoNames } = await fourPhotoProject("qwen_image_21_7B", {
      maxItems: 3, maxReferences: 8,
    });
    await env.media.generateProjectMediaPhased(project.id, ids);
    expect(references(client.calls[0]!)).toHaveLength(3);
    expect(references(client.calls.at(-1)!)).toHaveLength(3);
    expect(references(client.calls.at(-1)!).slice(1).map((ref) => path.basename(ref))).toEqual(photoNames.slice(0, 2));
    expect(String(client.calls.at(-1)!.prompt)).toContain("2 character reference photographs");
  });

  it("uses the substituted model's capacity, not the incompatible project pin", async () => {
    const { env, client, project, ids } = await fourPhotoProject("plain_image", { noReferences: true });
    await env.media.generateProjectMediaPhased(project.id, ids);
    const record = await env.projects.getProjectRecord(project.id);
    expect(references(client.calls[0]!)).toHaveLength(1);
    expect(references(client.calls.at(-1)!)).toEqual([record.attempts![ids[0]!]![0]!.endImagePath]);
  });

  it("sends no character photos when that project option is disabled", async () => {
    const { env, client, project, ids, photoNames } = await fourPhotoProject("qwen_image_21_7B");
    await env.projects.updateProjectModels(project.id, { useCharacterReferenceImages: false });
    await env.media.generateProjectMediaPhased(project.id, ids);
    expect(references(client.calls[0]!)).toEqual([]);
    expect(references(client.calls.at(-1)!)).toHaveLength(1);
    expect(client.calls.flatMap(references).some((ref) => photoNames.includes(path.basename(ref)))).toBe(false);
  });

  it("withholds the carried frame on an opted-out scene but still fits all four character photos", async () => {
    const { env, client, project, ids, photoNames } = await fourPhotoProject("qwen_image_21_7B");
    await env.projects.updateSceneFraming(project.id, ids[1]!, { endFrameReference: false });
    await env.media.generateProjectMediaPhased(project.id, ids);
    expect(references(client.calls.at(-1)!).map((ref) => path.basename(ref))).toEqual(photoNames);
    expect(client.calls.at(-1)!.video_prompt_type).toBe("I");
  });

  it("refuses a zero-capacity schema before submitting any image job", async () => {
    const { env, client, project, ids } = await fourPhotoProject("qwen_image_21_7B", { maxItems: 0 });
    await expect(env.media.generateSceneMedia(project.id, ids[0]!)).rejects.toThrow(/capacity of zero/);
    expect(client.calls).toHaveLength(0);
  });
});
