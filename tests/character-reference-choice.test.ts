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
    name: "tracey.png",
    type: "image/png",
    size: PIXEL.byteLength,
    arrayBuffer: async () =>
      PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.byteLength),
  }) as unknown as File;

async function pokerProject(env: Env, useRefs: boolean) {
  const character = await env.characters.createCharacter({
    name: "Tracey",
    description: "A woman in her fifties.",
    faceSwap: true,
  });
  await env.characters.setReferenceImage(character.id, pngFile());

  const project = await env.projects.createProject({
    concept: "Four men play poker while Tracey watches from the doorway.",
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
});
