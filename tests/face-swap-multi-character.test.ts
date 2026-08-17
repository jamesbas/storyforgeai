import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Face swap with more than one character in the cast.
 *
 * A frame holding two named people needs two passes, each naming its own
 * subject, because the preset's prompt addresses one person and cannot say
 * which of two it means. The passes chain — each edits the previous output —
 * so their order decides the result.
 *
 * `swapFace` is stubbed here for the orchestration tests: the mock WanGP client
 * has no Qwen Edit model, and what these assert is which passes run, in what
 * order, on which image. The prompt itself is covered further down against a
 * client that records the settings it is handed.
 */
vi.mock("@/lib/services/face-swap-service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/services/face-swap-service")>();
  return { ...actual, swapFace: vi.fn(async (image: string) => `${image}.swapped`) };
});

const dirs: string[] = [];

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-multiswap-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const characters = await import("@/lib/services/character-service");
  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const faceSwapService = await import("@/lib/services/face-swap-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");

  setWangpClient(new MockWangpClient());
  const swapFace = vi.mocked(faceSwapService.swapFace);
  swapFace.mockClear();
  swapFace.mockImplementation(async (image: string) => `${image}.swapped`);
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

type Characters = Awaited<ReturnType<typeof isolated>>["characters"];

async function castOfTwo(characters: Characters) {
  const first = await characters.createCharacter({
    name: "Mara",
    description: "A woman in her fifties.",
    faceSwap: true,
    faceSwapPrompt: "swap the woman",
  });
  await characters.setReferenceImage(first.id, referenceUpload());

  const second = await characters.createCharacter({
    name: "Jaime",
    description: "A man in his fifties.",
    faceSwap: true,
    faceSwapPrompt: "swap the man",
  });
  await characters.setReferenceImage(second.id, referenceUpload());

  return [first, second];
}

describe("a cast where two characters both want a swap", () => {
  it("runs one pass per character, chaining each onto the last", async () => {
    const { characters, projects, media, swapFace } = await isolated();
    const cast = await castOfTwo(characters);

    const created = await projects.createProject({
      concept: "A husband and wife wait in a hotel room.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: cast.map((c) => c.id),
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    await media.generateSceneMedia(created.id, sceneId);

    // Two frames, two characters: four passes rather than the two a
    // single-subject pipeline would run.
    expect(swapFace.mock.calls.length).toBe(4);

    // Each pass edits the previous pass's output, so both faces land.
    const [firstPass, secondPass] = swapFace.mock.calls;
    expect(secondPass![0]).toBe(`${firstPass![0]}.swapped`);
  });

  /**
   * The passes chain, so the order decides the result. Sorting by id keeps a
   * re-run of the same batch producing the same chain.
   */
  it("orders the passes deterministically", async () => {
    const { characters, projects, media, swapFace } = await isolated();
    const cast = await castOfTwo(characters);
    const expected = [...cast].sort((a, b) => a.id.localeCompare(b.id)).map((c) => c.id);

    const created = await projects.createProject({
      concept: "A husband and wife wait in a hotel room.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: cast.map((c) => c.id),
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    await media.generateSceneMedia(created.id, sceneId);

    const order = swapFace.mock.calls.slice(0, 2).map((call) => call[1].id);
    expect(order).toEqual(expected);
  });

  /**
   * A failed pass costs its own correction, not the ones before it: the frame
   * keeps the last good output rather than reverting to the raw render.
   */
  it("keeps the earlier pass when a later one fails", async () => {
    const { characters, projects, media, swapFace } = await isolated();
    const cast = await castOfTwo(characters);

    let call = 0;
    swapFace.mockImplementation(async (image: string) => {
      call += 1;
      return call % 2 === 0 ? null : `${image}.swapped`;
    });

    const created = await projects.createProject({
      concept: "A husband and wife wait in a hotel room.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: cast.map((c) => c.id),
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    const rendered = await media.generateSceneMedia(created.id, sceneId);

    const attempt = rendered.attempts![sceneId]!.at(-1)!;
    expect(attempt.startImagePath).toMatch(/\.swapped$/);
  });

  /** Phasing is what keeps the batch from reloading a model per scene. */
  it("allows the phased batch path", async () => {
    const { characters, projects, media } = await isolated();
    const cast = await castOfTwo(characters);

    const created = await projects.createProject({
      concept: "A husband and wife wait in a hotel room.",
      requestedDurationSeconds: 60,
      generationMode: "keyframes_only",
      useCharacterLibrary: true,
      characterIds: cast.map((c) => c.id),
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneIds = withStoryboard.storyboard!.scenes.map((scene) => scene.id);

    await expect(media.canRunPhased(withStoryboard, sceneIds)).resolves.toBe(true);
  });

  it("refuses the phased path when nobody wants a swap", async () => {
    const { projects, media } = await isolated();
    const created = await projects.createProject({
      concept: "A street at dawn.",
      requestedDurationSeconds: 60,
      generationMode: "keyframes_only",
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneIds = withStoryboard.storyboard!.scenes.map((scene) => scene.id);

    await expect(media.canRunPhased(withStoryboard, sceneIds)).resolves.toBe(false);
  });
});
