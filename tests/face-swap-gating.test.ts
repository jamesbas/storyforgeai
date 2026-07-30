import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Whether the face-swap pass runs at all.
 *
 * The swap prompt is unconditional — told to replace "the head of the woman" in
 * a close-up of hands or a shot from behind, the edit model grafts a head onto
 * the composition rather than declining. The storyboard already knows which
 * shots frame a face, so that is where the decision belongs.
 *
 * The swap itself needs an installed Qwen Edit model, which the mock client has
 * none of, so it is stubbed: these tests are about whether the pass is invoked.
 */
vi.mock("@/lib/services/face-swap-service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/services/face-swap-service")>();
  return { ...actual, swapFace: vi.fn(async () => "/swapped.png") };
});

const dirs: string[] = [];

/**
 * The character library is one JSON file under the data dir, rewritten whole on
 * every change. Two test files creating characters at once lose each other's
 * writes, so this one works in a directory of its own.
 */
async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-faceswap-"));
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
  // The stub survives resetModules, so its call log has to be cleared per run.
  const swapFace = vi.mocked(faceSwapService.swapFace);
  swapFace.mockClear();
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

async function renderOneScene(faceVisible: boolean) {
  const { characters, projects, media, swapFace } = await isolated();

  const character = await characters.createCharacter({
    name: "Lead",
    description: "A woman in her fifties.",
    faceSwap: true,
  });
  await characters.setReferenceImage(character.id, referenceUpload());

  const created = await projects.createProject({
    concept: "A woman lines up a shot in a quiet bar.",
    requestedDurationSeconds: 20,
    generationMode: "keyframes_only",
    useCharacterLibrary: true,
    characterIds: [character.id],
  });
  const withStoryboard = await projects.generateStoryboard(created.id);
  const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
  if (!faceVisible) {
    await projects.updateSceneFraming(created.id, sceneId, { subjectFaceVisible: false });
  }

  const record = await media.generateSceneMedia(created.id, sceneId);
  return {
    swaps: swapFace.mock.calls.length,
    record,
    sceneId,
    projectId: created.id,
    media,
    projects,
  };
}

describe("gating the face swap on the planned shot", () => {
  it("swaps both keyframes when the shot shows a face", async () => {
    const { swaps } = await renderOneScene(true);
    expect(swaps).toBe(2);
  });

  it("swaps neither when the shot shows no face", async () => {
    const { swaps, record, sceneId } = await renderOneScene(false);
    expect(swaps).toBe(0);
    // Skipping the swap must not skip the render.
    expect(record.attempts?.[sceneId]?.[0]?.startImagePath).toBeTruthy();
  });
});

/**
 * The repair path. The automatic pass is decided before anything is drawn, and
 * the plan can be wrong in either direction — a shot planned as a close-up of
 * hands can come back framing the face.
 */
describe("swapping one frame after the fact", () => {
  it("replaces the named frame and leaves the other alone", async () => {
    const { projectId, sceneId, media, record } = await renderOneScene(false);
    const original = record.attempts![sceneId]![0]!;

    const updated = await media.swapAttemptFrame(projectId, sceneId, "start_frame");
    const attempt = updated.attempts![sceneId]![0]!;

    expect(attempt.startImagePath).toBe("/swapped.png");
    expect(attempt.endImagePath).toBe(original.endImagePath);
  });

  it("refuses when the scene has no media yet", async () => {
    const { projects, media } = await isolated();
    const created = await projects.createProject({
      concept: "Nothing rendered here.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;

    await expect(media.swapAttemptFrame(created.id, sceneId, "start_frame")).rejects.toThrow(
      /Generate this scene's media/,
    );
  });

  it("refuses when no character is set up for a swap", async () => {
    const { projects, media } = await isolated();
    const created = await projects.createProject({
      concept: "A street at dawn.",
      requestedDurationSeconds: 20,
      generationMode: "keyframes_only",
    });
    const withStoryboard = await projects.generateStoryboard(created.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    await media.generateSceneMedia(created.id, sceneId);

    await expect(media.swapAttemptFrame(created.id, sceneId, "start_frame")).rejects.toThrow(
      /exactly one character/,
    );
  });
});
