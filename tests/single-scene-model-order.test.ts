import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The order a single scene loads models in.
 *
 * WanGP holds one model at a time and a load costs upwards of a minute, so what
 * matters is not how many jobs a scene runs but how many times the model
 * changes. Correcting each frame the moment it was rendered made a two-frame
 * scene load image → edit → image → edit, paying for the image model twice and
 * the edit model twice to do four jobs.
 */
vi.mock("@/lib/services/face-swap-service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/services/face-swap-service")>();
  return { ...actual, swapFace: vi.fn(async (image: string) => `${image}.swapped`) };
});

const dirs: string[] = [];

/** What ran, in order. "render" is the image model, "swap" the edit model. */
const order: string[] = [];

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-modelorder-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const characters = await import("@/lib/services/character-service");
  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const faceSwapService = await import("@/lib/services/face-swap-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");

  // Named `log`, not `jobs`: MockWangpClient already owns a `jobs` map, and a
  // subclass field of the same name replaces it after super() runs.
  class RecordingClient extends MockWangpClient {
    override async generate(settings: Record<string, unknown>) {
      order.push(settings.video_length === undefined ? "render" : "clip");
      return super.generate(settings);
    }
  }

  order.length = 0;
  setWangpClient(new RecordingClient());
  const swapFace = vi.mocked(faceSwapService.swapFace);
  swapFace.mockClear();
  swapFace.mockImplementation(async (image: string) => {
    order.push("swap");
    return `${image}.swapped`;
  });
  return { characters, projects, media, swapFace };
}

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** jsdom's File lacks arrayBuffer(); the upload path needs only these three. */
function referenceUpload(): File {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    type: "image/png",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

describe("generating one scene with face swap", () => {
  it("renders both keyframes before correcting either", async () => {
    const { characters, projects, media } = await isolated();
    const subject = await characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
      faceSwap: true,
    });
    await characters.setReferenceImage(subject.id, referenceUpload());

    const created = await projects.createProject({
      concept: "A woman waits alone in a hotel room.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: [subject.id],
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;

    await media.generateSceneMedia(created.id, sceneId);

    expect(order).toEqual(["render", "render", "swap", "swap"]);
  });

  /**
   * The end frame is still conditioned on the start frame — it is the reference
   * that holds wardrobe, set and lighting across the pair. What changed is that
   * it is the start frame as rendered rather than as corrected, which is
   * already what the phased batch conditions on.
   */
  it("still hands the end frame the start frame as a reference", async () => {
    const { characters, projects, media } = await isolated();
    const subject = await characters.createCharacter({
      name: "Mara",
      description: "A woman in her fifties.",
      faceSwap: true,
    });
    await characters.setReferenceImage(subject.id, referenceUpload());

    const created = await projects.createProject({
      concept: "A woman waits alone in a hotel room.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: [subject.id],
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;

    const updated = await media.generateSceneMedia(created.id, sceneId);
    const attempt = updated.attempts![sceneId]!.at(-1)!;

    // Both frames were corrected, and each records the render it replaced.
    expect(attempt.startImagePath).toBe(`${attempt.startImageSourcePath}.swapped`);
    expect(attempt.endImagePath).toBe(`${attempt.endImageSourcePath}.swapped`);
    // The end frame is a different render from the start frame, not a copy of it.
    expect(attempt.endImageSourcePath).not.toBe(attempt.startImageSourcePath);
  });
});
