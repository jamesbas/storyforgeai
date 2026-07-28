import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, deleteProject, generateStoryboard, listProjects } from "@/lib/services/project-service";
import { FileProjectRepository } from "@/lib/db/file-repository";

/**
 * Deleting a project.
 *
 * The destructive half is a recursive directory removal driven by an id that
 * arrives from a URL, so the containment guards matter more than the happy path.
 */

async function project(concept = "A keeper leaves the island.") {
  const created = await createProject({ concept, requestedDurationSeconds: 40 });
  return generateStoryboard(created.id);
}

describe("deleting a project", () => {
  it("removes it from the listing", async () => {
    const record = await project();
    expect((await listProjects()).some((p) => p.id === record.project.id)).toBe(true);

    await deleteProject(record.project.id);

    expect((await listProjects()).some((p) => p.id === record.project.id)).toBe(false);
  });

  it("rejects an unknown project rather than silently succeeding", async () => {
    await expect(deleteProject("no-such-project")).rejects.toThrow(/not found/i);
  });

  /**
   * The existence check runs first precisely so a mistyped id cannot cancel a
   * running batch as a side effect of a 404.
   */
  it("checks the project exists before tearing anything down", async () => {
    const queue = await import("@/lib/services/scene-queue");
    const cancel = vi.spyOn(queue, "cancelQueue");
    await expect(deleteProject("no-such-project")).rejects.toThrow();
    expect(cancel).not.toHaveBeenCalled();
    cancel.mockRestore();
  });
});

describe("file repository purge", () => {
  let dir: string;
  let repo: FileProjectRepository;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-purge-"));
    vi.stubEnv("STORYFORGE_DATA_DIR", dir);
    vi.resetModules();
    const { FileProjectRepository: Repo } = await import("@/lib/db/file-repository");
    repo = new Repo();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed(id: string) {
    const record = {
      project: {
        id,
        title: "Purge me",
        concept: "x",
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as never;
    await repo.create(record);
    // Stand in for rendered output living beside the record.
    await fs.writeFile(path.join(dir, id, "scene-001.mp4"), "video");
    return record;
  }

  it("removes the record and the generated media beside it", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    await seed(id);
    expect(await repo.purge(id)).toBe(true);
    await expect(fs.stat(path.join(dir, id))).rejects.toThrow();
  });

  it("keeps the media when only the record is deleted", async () => {
    const id = "66666666-7777-8888-9999-000000000000";
    await seed(id);
    await repo.delete(id);

    await expect(fs.stat(path.join(dir, id, "project.json"))).rejects.toThrow();
    // The clip survives: `delete` is the "keep media" path.
    expect(await fs.readFile(path.join(dir, id, "scene-001.mp4"), "utf8")).toBe("video");
  });

  /** The id reaches a recursive delete, so traversal must be refused outright. */
  it.each(["../escape", "a/b", "..", "with space/../.."])(
    "refuses to purge unsafe id %s",
    async (id) => {
      await expect(repo.purge(id)).rejects.toThrow(/unsafe project id/i);
    },
  );

  it("reports false for an id that was never stored", async () => {
    expect(await repo.purge("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(false);
  });
});
