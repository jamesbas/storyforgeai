import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Importing a keyframe by hand.
 *
 * The picture sometimes already exists — a photograph, or StoryForge's own
 * render taken away and edited — and no amount of re-rolling a seed will make
 * the model produce it. The import replaces the frame on the latest attempt in
 * place, so everything that reads a frame path picks it up; what it must never
 * do is quietly leave something downstream pointing at the image it replaced.
 */

const dirs: string[] = [];
let dataDir: string | null = null;

/** One temp directory per file: the repository singleton outlives resetModules. */
async function isolated() {
  if (!dataDir) {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-import-frame-"));
    dirs.push(dataDir);
  }
  process.env.STORYFORGE_DATA_DIR = dataDir;
  vi.resetModules();

  const projects = await import("@/lib/services/project-service");
  const media = await import("@/lib/services/media-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(new MockWangpClient());
  return { projects, media, dataDir };
}

afterAll(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  dataDir = null;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** The node test env's File has no arrayBuffer(); the upload path needs four fields. */
function upload(type = "image/png", bytes = new Uint8Array([137, 80, 78, 71])): File {
  return {
    name: "frame.png",
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

const sceneIdsOf = (record: ProjectRecord) => record.storyboard!.scenes.map((s) => s.id);

async function chained(concept: string) {
  const { projects, media } = await isolated();
  const created = await projects.createProject({
    concept,
    requestedDurationSeconds: 60,
    sceneContinuity: "reuse_end_frame",
  });
  const record = await projects.generateStoryboard(created.id);
  return { projects, media, projectId: created.id, sceneIds: sceneIdsOf(record) };
}

describe("importing a keyframe", () => {
  it("replaces the frame on the latest attempt and copies the bytes into the project", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A lighthouse keeper repaints the lamp room.",
    );
    await media.generateSceneMedia(projectId, sceneIds[0]!);
    const before = (await projects.getProjectRecord(projectId)).attempts![sceneIds[0]!]![0]!;

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "start_frame", upload());
    const after = result.record.attempts![sceneIds[0]!]!.at(-1)!;

    expect(after.id).toBe(before.id);
    expect(after.startImagePath).not.toBe(before.startImagePath);
    expect(after.startImageImported).toBe(true);
    // The end frame is untouched, and neither is a new attempt opened.
    expect(after.endImagePath).toBe(before.endImagePath);
    expect(result.record.attempts![sceneIds[0]!]).toHaveLength(1);

    expect(after.startImagePath!.startsWith(path.resolve(dataDir!, projectId))).toBe(true);
    await expect(fs.readFile(after.startImagePath!)).resolves.toBeTruthy();
  });

  it("reports that the clip it already had no longer matches the frames", async () => {
    const { media, projectId, sceneIds } = await chained("A courier crosses a frozen lake.");
    await media.generateSceneMedia(projectId, sceneIds[0]!);

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "end_frame", upload());
    expect(result.clipStale).toBe(true);
  });

  it("drops the swap provenance, so undo cannot overwrite the imported image", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "A diver surfaces beside an empty boat.",
    );
    await media.generateSceneMedia(projectId, sceneIds[0]!);

    // Stand in for a face swap: what matters is that a source path exists.
    const record = await projects.getProjectRecord(projectId);
    const attempts = record.attempts![sceneIds[0]!]!;
    await (await import("@/lib/db/store")).repository.update(projectId, {
      ...record,
      attempts: {
        ...record.attempts,
        [sceneIds[0]!]: attempts.map((a) => ({ ...a, startImageSourcePath: "original.png" })),
      },
    });

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "start_frame", upload());
    expect(result.record.attempts![sceneIds[0]!]!.at(-1)!.startImageSourcePath).toBeUndefined();
  });

  it("refuses before the scene has an attempt to put the frame on", async () => {
    const { media, projectId, sceneIds } = await chained("A cartographer loses a page.");
    await expect(
      media.importAttemptFrame(projectId, sceneIds[0]!, "start_frame", upload()),
    ).rejects.toThrow(/generate this scene's media first/i);
  });

  it("rejects a file that is not an image type it can serve", async () => {
    const { media, projectId, sceneIds } = await chained("A gardener finds a key in the soil.");
    await media.generateSceneMedia(projectId, sceneIds[0]!);
    await expect(
      media.importAttemptFrame(projectId, sceneIds[0]!, "start_frame", upload("application/pdf")),
    ).rejects.toThrow(/PNG, JPEG or WebP/i);
  });
});

describe("carrying an imported end frame into the next scene", () => {
  it("replaces the start frame of a scene that inherited the old one", async () => {
    const { media, projectId, sceneIds } = await chained("A signalman waits for a train.");
    await media.generateProjectMediaPhased(projectId, sceneIds);

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "end_frame", upload());
    const imported = result.record.attempts![sceneIds[0]!]!.at(-1)!.endImagePath;

    expect(result.cascadedTo?.sceneId).toBe(sceneIds[1]!);
    const next = result.record.attempts![sceneIds[1]!]!.at(-1)!;
    expect(next.startImagePath).toBe(imported);
    expect(next.startImageImported).toBe(true);
    // Still carried over, so the card keeps explaining why its prompt did nothing.
    expect(next.startImageInherited).toBe(true);
  });

  it("leaves a start frame the next scene rendered for itself alone", async () => {
    const { projects, media, projectId, sceneIds } = await chained(
      "Two rivals meet in separate cities.",
    );
    await media.generateProjectMediaPhased(projectId, sceneIds);

    const record = await projects.getProjectRecord(projectId);
    const nextAttempts = record.attempts![sceneIds[1]!]!;
    await (await import("@/lib/db/store")).repository.update(projectId, {
      ...record,
      attempts: {
        ...record.attempts,
        [sceneIds[1]!]: nextAttempts.map((a) => ({ ...a, startImageInherited: undefined })),
      },
    });
    const own = nextAttempts.at(-1)!.startImagePath;

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "end_frame", upload());
    expect(result.cascadedTo).toBeUndefined();
    expect(result.record.attempts![sceneIds[1]!]!.at(-1)!.startImagePath).toBe(own);
  });

  it("does not carry a start-frame import forward", async () => {
    const { media, projectId, sceneIds } = await chained("A baker opens before dawn.");
    await media.generateProjectMediaPhased(projectId, sceneIds);

    const result = await media.importAttemptFrame(projectId, sceneIds[0]!, "start_frame", upload());
    expect(result.cascadedTo).toBeUndefined();
  });

  it("does not carry forward when the project cuts between scenes", async () => {
    const { projects, media } = await isolated();
    const created = await projects.createProject({
      concept: "An auctioneer sells a house nobody wants.",
      requestedDurationSeconds: 60,
      sceneContinuity: "cut",
    });
    const record = await projects.generateStoryboard(created.id);
    const sceneIds = sceneIdsOf(record);
    await media.generateProjectMediaPhased(created.id, sceneIds);

    const result = await media.importAttemptFrame(created.id, sceneIds[0]!, "end_frame", upload());
    expect(result.cascadedTo).toBeUndefined();
  });
});
