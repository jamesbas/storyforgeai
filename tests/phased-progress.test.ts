import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chipLabel, phaseLabel } from "@/components/storyboard/phase-labels";
import type { SceneQueueEntry } from "@/lib/services/scene-queue";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * What a phased batch shows while it is still running.
 *
 * Phase 1 is hours of GPU time on a full storyboard. It used to hold every
 * keyframe in memory until the swap phase ended, so for all of it the storyboard
 * read "No media generated yet", every chip read "running", and the only number
 * that moved counted attempts rather than renders. A cancel then threw the lot
 * away.
 */

/**
 * The swap needs an installed Qwen Edit model, which the mock client has none
 * of. A distinct path per frame is what makes the in-place rewrite of a banked
 * attempt observable.
 */
vi.mock("@/lib/services/face-swap-service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/services/face-swap-service")>();
  return { ...actual, swapFace: vi.fn(async (imagePath: string) => `${imagePath}.swapped.png`) };
});

const dirs: string[] = [];

/** The character library is one file under the data dir, so each run gets its own. */
async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-phased-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const characters = await import("@/lib/services/character-service");
  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");

  setWangpClient(new MockWangpClient());
  return { characters, projects, media };
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

async function seeded() {
  const { characters, projects, media } = await isolated();
  const created = await characters.createCharacter({
    name: "Tracey",
    description: "A woman in her forties, tall, with dark hair.",
    faceSwap: true,
  });
  await characters.setReferenceImage(created.id, referenceUpload());

  const project = await projects.createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 60,
    useCharacterLibrary: true,
    characterIds: [created.id],
  });
  const record = await projects.generateStoryboard(project.id);
  const sceneIds = record.storyboard!.scenes.map((s) => s.id);
  const read = () => projects.getProjectRecord(project.id);
  return { projectId: project.id, sceneIds, media, read };
}

const allAttempts = (record: ProjectRecord) => Object.values(record.attempts ?? {}).flat();

describe("keyframes reaching the storyboard while the batch runs", () => {
  it("banks a scene's frames before the swap phase starts", async () => {
    const { projectId, sceneIds, media, read } = await seeded();
    let bankedAtSwap = 0;

    await media.generateProjectMediaPhased(projectId, sceneIds, {
      onPhase: async (phase) => {
        if (phase !== "face_swap") return;
        bankedAtSwap = allAttempts(await read()).length;
      },
    });

    expect(bankedAtSwap).toBe(sceneIds.length);
  });

  /**
   * The keyframes are the expensive half of a run. Cancelling used to discard
   * every one of them, because nothing was written until phase 2 had finished.
   */
  it("keeps the frames rendered before a cancel", async () => {
    const { projectId, sceneIds, media, read } = await seeded();
    let cleared = 0;

    await media.generateProjectMediaPhased(projectId, sceneIds, {
      shouldCancel: () => cleared >= 1,
      onSceneClearPhase: (_sceneId, phase) => {
        if (phase === "keyframes") cleared += 1;
      },
    });

    const banked = allAttempts(await read());
    expect(banked).toHaveLength(1);
    expect(banked[0]?.endImagePath).toBeTruthy();
    expect(banked[0]?.videoPath).toBeUndefined();
  });

  /**
   * The banked attempt is what the storyboard is already showing, so the swap
   * corrects it in place rather than leaving the pre-swap render on screen. The
   * original stays reachable through the source fields.
   */
  it("rewrites the banked attempt with the swapped frames", async () => {
    const { projectId, sceneIds, media, read } = await seeded();
    await media.generateProjectMediaPhased(projectId, sceneIds, {});

    const record = await read();
    const attempts = record.attempts![sceneIds[0]!]!;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.endImagePath).toMatch(/\.swapped\.png$/);
    expect(attempts[0]!.endImageSourcePath).toBeTruthy();
    expect(attempts[0]!.endImagePath).not.toBe(attempts[0]!.endImageSourcePath);
  });
});

describe("reporting where each scene has got to", () => {
  it("moves a scene through its phases in order", async () => {
    const { projectId, sceneIds, media } = await seeded();
    const cleared: string[] = [];

    await media.generateProjectMediaPhased(projectId, sceneIds, {
      onSceneClearPhase: (sceneId, phase) => {
        if (sceneId === sceneIds[0]) cleared.push(phase);
      },
    });

    expect(cleared).toEqual(["keyframes", "face_swap", "video"]);
  });

  /**
   * The counter used to advance outside the try, so a phase that failed half its
   * scenes still read as fully done.
   */
  it("counts renders that succeeded, and failures apart from them", async () => {
    const { projectId, sceneIds, media } = await seeded();
    const progress: [number, number][] = [];
    let renderingFrames = false;
    let job = 0;

    await media.generateProjectMediaPhased(projectId, sceneIds, {
      onPhase: (phase) => {
        renderingFrames = phase === "keyframes";
      },
      onPhaseProgress: (completed, failed) => {
        if (renderingFrames) progress.push([completed, failed]);
      },
      runStep: async (step) => {
        if (renderingFrames) {
          job += 1;
          if (job === 1) throw new Error("fetch failed");
        }
        return step();
      },
    });

    expect(progress[0]).toEqual([0, 1]);
    expect(progress.at(-1)).toEqual([sceneIds.length - 1, 1]);
  });
});

describe("what a chip says", () => {
  const entry = (overrides: Partial<SceneQueueEntry> = {}): SceneQueueEntry => ({
    projectId: "p1",
    sceneId: "p1-scene-001",
    sceneNumber: 1,
    state: "running",
    scope: "full",
    attempts: 1,
    ...overrides,
  });

  it("names the phase a running scene is in", () => {
    expect(chipLabel(entry({ phase: "keyframes" }), true)).toBe("rendering keyframes");
  });

  /** Twenty-four chips reading "running" for hours is what this replaces. */
  it("says a scene's keyframes are banked once it clears phase one", () => {
    expect(chipLabel(entry({ completedPhase: "keyframes" }), true)).toBe("keyframes done");
  });

  it("falls back to the lifecycle state off the phased path", () => {
    expect(chipLabel(entry(), true)).toBe("running");
    expect(chipLabel(entry({ state: "failed" }), true)).toBe("failed");
  });

  /**
   * The clip phase runs in a keyframes-only project too — it closes the attempts
   * out — but it renders nothing, so calling it clips is a plain untruth.
   */
  it("does not claim to render clips a keyframes-only project never asked for", () => {
    expect(phaseLabel("video", true)).toBe("Rendering clips");
    expect(phaseLabel("video", false)).toBe("Finishing scenes");
    expect(chipLabel(entry({ phase: "video" }), false)).toBe("finishing");
  });
});
