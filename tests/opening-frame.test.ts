import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/**
 * Pinning the image the story opens on.
 *
 * Scene 1's start frame is the one keyframe nothing upstream can supply, and
 * under `reuse_end_frame` every later frame descends from it — so a real
 * photograph pinned there governs the whole chain. The distinction from
 * `importAttemptFrame` is timing: that one replaces a frame on a finished
 * attempt, which is far too late to influence anything rendered from it.
 *
 * What must hold: no start frame is rendered for scene 1, re-running generation
 * cannot overwrite it, and an image of the wrong shape is cropped rather than
 * refused — cameras and image models rarely emit the project's exact ratio.
 */

const dirs: string[] = [];
let dataDir: string | null = null;

/** One temp directory per file: the repository singleton outlives resetModules. */
async function isolated() {
  if (!dataDir) {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-opening-frame-"));
    dirs.push(dataDir);
  }
  process.env.STORYFORGE_DATA_DIR = dataDir;
  vi.resetModules();

  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(new MockWangpClient());
  return { projects, media };
}

afterAll(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  dataDir = null;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A real PNG, since the crop decodes it rather than reading the header. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 40, b: 80 } },
  })
    .png()
    .toBuffer();
}

/** The node test env's File has no arrayBuffer(); the upload path needs four fields. */
async function upload(width = 1280, height = 720, type = "image/png"): Promise<File> {
  const bytes = await png(width, height);
  return {
    name: "opening.png",
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

async function chained(concept: string) {
  const { projects, media } = await isolated();
  const created = await projects.createProject({
    concept,
    requestedDurationSeconds: 60,
    sceneContinuity: "reuse_end_frame",
  });
  const record = await projects.generateStoryboard(created.id);
  return {
    projects,
    media,
    projectId: created.id,
    sceneIds: record.storyboard!.scenes.map((s) => s.id),
  };
}

describe("pinning the opening frame", () => {
  it("uses the supplied image as scene 1's start frame rather than rendering one", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A cartographer finishes a map of a coast nobody has walked.",
    );

    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);
    const framePath = pinned.record.project.openingFrame!.path;

    await media.generateSceneMedia(projectId, sceneIds[0]!);
    const attempt = (await projects.getProjectRecord(projectId)).attempts![sceneIds[0]!]!.at(-1)!;

    expect(attempt.startImagePath).toBe(framePath);
    expect(attempt.startImageImported).toBe(true);
    // The end frame is still rendered, or there would be nothing to move through.
    expect(attempt.endImagePath).toBeTruthy();
    expect(attempt.endImagePath).not.toBe(framePath);
  });

  it("copies the bytes into the project rather than trusting a path", async () => {
    const { media, projectId } = await chained("A diver surfaces beside an abandoned rig.");

    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);
    const framePath = pinned.record.project.openingFrame!.path;

    expect(framePath.startsWith(path.resolve(dataDir!, projectId))).toBe(true);
    await expect(fs.readFile(framePath)).resolves.toBeTruthy();
  });

  it("survives regenerating the scene, which is the whole point of pinning it", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A signalman waits out a storm in a mountain hut.",
    );
    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);
    const framePath = pinned.record.project.openingFrame!.path;

    await media.generateSceneMedia(projectId, sceneIds[0]!);
    await media.generateSceneMedia(projectId, sceneIds[0]!);

    const attempts = (await projects.getProjectRecord(projectId)).attempts![sceneIds[0]!]!;
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) expect(attempt.startImagePath).toBe(framePath);
  });

  it("anchors the chain, so the next scene descends from it", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "Two archivists catalogue a flooded basement.",
    );
    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);
    const framePath = pinned.record.project.openingFrame!.path;

    await media.generateProjectMediaPhased(projectId, [sceneIds[0]!, sceneIds[1]!]);

    const record = await projects.getProjectRecord(projectId);
    const first = record.attempts![sceneIds[0]!]!.at(-1)!;
    const second = record.attempts![sceneIds[1]!]!.at(-1)!;

    expect(first.startImagePath).toBe(framePath);
    expect(second.startImagePath).toBe(first.endImagePath);
  });

  it("holds through the batch path too, not just one scene at a time", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A beekeeper moves hives before the frost.",
    );
    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);

    await media.generateProjectMediaPhased(projectId, [sceneIds[0]!]);

    const attempt = (await projects.getProjectRecord(projectId)).attempts![sceneIds[0]!]!.at(-1)!;
    expect(attempt.startImagePath).toBe(pinned.record.project.openingFrame!.path);
    expect(attempt.startImageImported).toBe(true);
  });

  it("centre-crops a square image to the project's shape and says what it did", async () => {
    const { media, projectId } = await chained("A watchmaker loses a spring under the bench.");

    const pinned = await media.pinOpeningFrame(projectId, await upload(1024, 1024), false);

    expect(pinned.cropped).toEqual({
      from: { width: 1024, height: 1024 },
      to: { width: 1024, height: 576 },
    });

    // Reported, and actually done — the stored file is the cropped one.
    const stored = await sharp(pinned.record.project.openingFrame!.path).metadata();
    expect(stored.width! / stored.height!).toBeCloseTo(16 / 9, 2);
  });

  it("crops a tall image on its height rather than its width", async () => {
    const { media, projectId } = await chained("A ranger walks a firebreak at dusk.");

    const pinned = await media.pinOpeningFrame(projectId, await upload(832, 1216), false);

    expect(pinned.cropped!.to.width).toBe(832);
    expect(pinned.cropped!.to.height).toBe(468);
  });

  it("leaves a frame that is already the right shape untouched", async () => {
    const { media, projectId } = await chained("A ferryman counts the last crossing of the day.");

    const file = await upload(3840, 2160);
    const original = Buffer.from(await file.arrayBuffer());
    const pinned = await media.pinOpeningFrame(projectId, file, false);

    expect(pinned.cropped).toBeUndefined();
    // Byte for byte: no decode, no re-encode, so "used exactly as supplied" holds.
    const stored = await fs.readFile(pinned.record.project.openingFrame!.path);
    expect(stored.equals(original)).toBe(true);
  });

  it("accepts the app's own 1920x1088 preset without calling it a crop", async () => {
    const { media, projectId } = await chained("A miller opens the sluice at first light.");

    const pinned = await media.pinOpeningFrame(projectId, await upload(1920, 1088), false);
    expect(pinned.cropped).toBeUndefined();
  });

  it("releases the pin, so scene 1 renders its own start frame again", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A gardener discovers a door behind the ivy.",
    );
    const pinned = await media.pinOpeningFrame(projectId, await upload(), false);
    const framePath = pinned.record.project.openingFrame!.path;

    const released = await media.unpinOpeningFrame(projectId);
    expect(released.project.openingFrame).toBeUndefined();

    await media.generateSceneMedia(projectId, sceneIds[0]!);
    const attempt = (await projects.getProjectRecord(projectId)).attempts![sceneIds[0]!]!.at(-1)!;

    expect(attempt.startImagePath).toBeTruthy();
    expect(attempt.startImagePath).not.toBe(framePath);
    expect(attempt.startImageImported).toBeUndefined();

    // The file itself stays: an attempt made while it was pinned still shows it.
    await expect(fs.readFile(framePath)).resolves.toBeTruthy();
  });

  it("serves the pinned frame, so the crop can be judged before anything renders", async () => {
    const { projects, media, projectId } = await chained("A cellist rehearses in an empty hall.");
    const pinned = await media.pinOpeningFrame(projectId, await upload(1024, 1024), false);

    const { parseMediaRef, resolveMediaPath } = await import("@/lib/media/refs");
    const record = await projects.getProjectRecord(projectId);
    const resolved = resolveMediaPath(record, parseMediaRef("opening-frame")!);

    expect(resolved).toBe(pinned.record.project.openingFrame!.path);
  });

  it("reports scene 1's start frame as a job the preview will not submit", async () => {
    const { media, projectId } = await chained("A carpenter fits the last stair tread.");
    await media.pinOpeningFrame(projectId, await upload(), false);

    const preview = await media.previewSceneRenders(projectId);
    const opening = preview.find((f) => f.sceneNumber === 1 && f.purpose === "start_frame")!;

    expect(opening.rendered).toBe(false);
    expect(opening.pinned).toBe(true);
    expect(opening.settings).toBeUndefined();
  });
});
