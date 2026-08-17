import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    const jaime = await env.characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties, in a white polo shirt.",
    });
    await env.characters.setReferenceImage(jaime.id, pngFile());

    const project = await env.projects.createProject({
      concept: "Mara and Jaime share a hotel suite.",
      requestedDurationSeconds: 20,
      useCharacterLibrary: true,
      characterIds: [mara.id, jaime.id],
    });
    const built = await env.projects.generateStoryboard(project.id);
    const scene = built.storyboard!.scenes[0]!;

    // The card holds both; only the end frame frames Jaime.
    await env.projects.updateSceneCard(project.id, scene.id, {
      visualDescription: "Mara stands by the door. Jaime waits in a corner chair.",
      actionDescription: "Mara looks toward Jaime.",
    });
    await env.projects.updateScenePrompts(project.id, scene.id, {
      startFramePrompt: "Close on Mara alone at the door. Exactly one person is in frame.",
      endFramePrompt: "Jaime rises from the corner chair as Mara turns to look at him.",
    });

    const client = new env.MockWangpClient();
    const submitted = vi.spyOn(client, "generate");
    env.setWangpClient(client);
    await env.media.generateSceneMedia(project.id, scene.id);

    const jaimePhoto = (await env.characters.getCharacter(jaime.id)).referenceImages![0]!;
    const refsFor = (needle: string) =>
      submitted.mock.calls
        .filter(([settings]) => String((settings as Record<string, unknown>).prompt ?? "").includes(needle))
        .flatMap(([settings]) => ((settings as Record<string, unknown>).image_refs as string[]) ?? []);

    expect(refsFor("alone at the door").some((p) => p.includes(jaimePhoto))).toBe(false);
    expect(refsFor("rises from the corner chair").some((p) => p.includes(jaimePhoto))).toBe(true);
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
    const jaime = await env.characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties.",
    });
    await env.characters.setReferenceImage(jaime.id, pngFile());

    const project = await env.projects.createProject({
      concept: "Mara and Jaime share a hotel suite.",
      requestedDurationSeconds: 20,
      useCharacterLibrary: true,
      characterIds: [mara.id, jaime.id],
    });
    const built = await env.projects.generateStoryboard(project.id);
    const scene = built.storyboard!.scenes[0]!;

    await env.projects.updateSceneCard(project.id, scene.id, {
      visualDescription: "Mara and Jaime stand together by the window.",
      actionDescription: "They look out at the street.",
    });
    await env.projects.updateScenePrompts(project.id, scene.id, {
      startFramePrompt: "Wide shot. Mara stands beside Jaime at the window.",
      endFramePrompt: "Wide shot. Mara leans on Jaime at the window.",
    });

    const client = new env.MockWangpClient();
    const submitted = vi.spyOn(client, "generate");
    env.setWangpClient(client);
    await env.media.generateSceneMedia(project.id, scene.id);

    const photos = [
      (await env.characters.getCharacter(mara.id)).referenceImages![0]!,
      (await env.characters.getCharacter(jaime.id)).referenceImages![0]!,
    ];
    for (const [settings] of submitted.mock.calls) {
      const refs = ((settings as Record<string, unknown>).image_refs as string[]) ?? [];
      const portraits = refs.filter((p) => photos.some((f) => p.includes(f)));
      expect(portraits.length).toBeLessThanOrEqual(1);
    }
  });

  /**
   * An edit model reads each reference as another element to place in the
   * frame rather than more evidence about one face, so a character carrying
   * four photographs was rendered twice in the same shot. The library still
   * earns its keep on the face swap, which takes them one at a time.
   */
  it("sends one photograph per character however many are stored", async () => {
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
