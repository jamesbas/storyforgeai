import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Durable project storage.
 *
 * A storyboard costs minutes of GPU time, so losing every project on restart is
 * the behaviour worth testing against: a second repository instance (standing
 * in for a restarted process) must see what the first one wrote.
 */

const dirs: string[] = [];

async function repositoryInTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-projects-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  const { FileProjectRepository } = await import("@/lib/db/file-repository");
  return { dir, make: () => new FileProjectRepository() };
}

function record(id: string, title: string) {
  const now = new Date().toISOString();
  return {
    project: {
      id,
      title,
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 40,
      segmentSeconds: 20,
      segmentCount: 2,
      generatedDurationSeconds: 40,
      finalTrimSeconds: 0,
      aspectRatio: "16:9" as const,
      resolutionPreset: "standard" as const,
      style: "cinematic",
      tone: "tense",
      creativeMode: "film_short" as const,
      narrationRequired: false,
      dialogueRequired: false,
      musicRequired: false,
      sfxRequired: false,
      generationMode: "storyboard_only" as const,
      modelStrategy: "auto" as const,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("file-backed project repository", () => {
  it("survives a restart", async () => {
    const { make } = await repositoryInTempDir();

    const first = make();
    await first.create(record("proj-1", "Flooded City"));

    // A fresh instance stands in for a restarted process.
    const second = make();
    const loaded = await second.get("proj-1");
    expect(loaded?.project.title).toBe("Flooded City");
    expect(await second.list()).toHaveLength(1);
  });

  it("writes one document per project beside its media", async () => {
    const { dir, make } = await repositoryInTempDir();
    const repo = make();
    await repo.create(record("proj-1", "One"));
    await repo.create(record("proj-2", "Two"));

    expect(await fs.readFile(path.join(dir, "proj-1", "project.json"), "utf8")).toContain("One");
    expect(await fs.readFile(path.join(dir, "proj-2", "project.json"), "utf8")).toContain("Two");
  });

  it("persists updates", async () => {
    const { make } = await repositoryInTempDir();
    const repo = make();
    const original = record("proj-1", "Before");
    await repo.create(original);
    await repo.update("proj-1", {
      ...original,
      project: { ...original.project, title: "After", status: "storyboard_ready" as const },
    });

    const reloaded = await make().get("proj-1");
    expect(reloaded?.project.title).toBe("After");
    expect(reloaded?.project.status).toBe("storyboard_ready");
  });

  /**
   * The cache was indexed once per process and never looked at the disk again,
   * so a prompt corrected by hand stayed invisible until a restart — and the
   * next save wrote the stale copy back over the correction.
   */
  it("picks up an edit made to the file behind its back", async () => {
    const { dir, make } = await repositoryInTempDir();
    const repo = make();
    await repo.create(record("proj-1", "Before"));
    expect((await repo.get("proj-1"))?.project.title).toBe("Before");

    const file = path.join(dir, "proj-1", "project.json");
    const edited = JSON.parse(await fs.readFile(file, "utf8"));
    edited.project.title = "Edited by hand";
    // Writes within the same millisecond would leave the timestamp unchanged.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(file, JSON.stringify(edited, null, 2), "utf8");

    expect((await repo.get("proj-1"))?.project.title).toBe("Edited by hand");
  });

  it("removes the record but leaves generated media alone", async () => {
    const { dir, make } = await repositoryInTempDir();
    const repo = make();
    await repo.create(record("proj-1", "One"));

    // Media is expensive to reproduce, so deleting a project must not bin it.
    const mediaDir = path.join(dir, "proj-1", "assembly");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "rough-cut.mp4"), "not-really-a-video");

    expect(await repo.delete("proj-1")).toBe(true);
    expect(await make().get("proj-1")).toBeNull();
    await expect(fs.access(path.join(mediaDir, "rough-cut.mp4"))).resolves.toBeUndefined();
  });

  it("skips an unreadable record rather than failing the whole listing", async () => {
    const { dir, make } = await repositoryInTempDir();
    const repo = make();
    await repo.create(record("proj-good", "Good"));
    await fs.mkdir(path.join(dir, "proj-bad"), { recursive: true });
    await fs.writeFile(path.join(dir, "proj-bad", "project.json"), "{ not valid json");

    const listed = await make().list();
    expect(listed.map((r) => r.project.id)).toEqual(["proj-good"]);
  });
});
