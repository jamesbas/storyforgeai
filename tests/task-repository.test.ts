import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Repository, lease and reconciliation behaviour (SPEC-008 §15).
 *
 * Each case gets its own data directory and a fresh module graph, because the
 * repository is a process-wide singleton keyed off `config.dataDir`, which is
 * read once at import.
 */

let dataDir: string;

/**
 * Simulate a process restart.
 *
 * `vi.resetModules()` alone is not enough: the repository and the worker id
 * live on `globalThis` so that an HMR reload reuses them, which is right in
 * production and wrong here — a real restart starts with empty globals.
 */
async function load() {
  vi.resetModules();
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.__storyforgeTaskRepo;
  delete globals.__storyforgeWorkerId;
  process.env.STORYFORGE_DATA_DIR = dataDir;
  process.env.STORYFORGE_PERSISTENCE = "file";
  const repo = await import("@/lib/db/task-repository");
  const service = await import("@/lib/tasks/task-service");
  return { ...repo, ...service };
}

const originalDir = process.env.STORYFORGE_DATA_DIR;
const originalPersistence = process.env.STORYFORGE_PERSISTENCE;

beforeEach(async () => {
  dataDir = path.join(os.tmpdir(), `sf-tasks-${randomUUID()}`);
  await fs.mkdir(dataDir, { recursive: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.__storyforgeTaskRepo;
  delete globals.__storyforgeWorkerId;
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.STORYFORGE_DATA_DIR;
  else process.env.STORYFORGE_DATA_DIR = originalDir;
  if (originalPersistence === undefined) delete process.env.STORYFORGE_PERSISTENCE;
  else process.env.STORYFORGE_PERSISTENCE = originalPersistence;
  vi.resetModules();
});

const PROJECT = "p1";
const taskFile = () => path.join(dataDir, PROJECT, "tasks.json");

function entries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ref: `${PROJECT}-scene-00${i + 1}`,
    label: `Scene ${i + 1}`,
    order: i + 1,
  }));
}

describe("durable storage", () => {
  it("returns an empty file when a project has no tasks yet", async () => {
    const { getTaskFile } = await load();
    const file = await getTaskFile(PROJECT);
    expect(file.tasks).toEqual([]);
    expect(file.revision).toBe(0);
  });

  it("writes tasks to disk beside the project record, not inside it", async () => {
    const { createTask } = await load();
    await createTask(PROJECT, "scene_batch", entries(2));
    // A corrupt task file must not be able to take the storyboard with it.
    await expect(fs.stat(taskFile())).resolves.toBeDefined();
  });

  it("survives a reload, which is the whole point", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", entries(3));

    const second = await load();
    const tasks = await second.listTasks(PROJECT);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].entries).toHaveLength(3);
  });

  it("advances the revision on every mutation", async () => {
    const { createTask, getTaskFile } = await load();
    await createTask(PROJECT, "scene_batch", entries(1));
    const one = (await getTaskFile(PROJECT)).revision;
    await createTask(PROJECT, "canvas_run", entries(1));
    expect((await getTaskFile(PROJECT)).revision).toBeGreaterThan(one);
  });

  it("leaves no temporary file behind after an atomic write", async () => {
    const { createTask } = await load();
    await createTask(PROJECT, "scene_batch", entries(1));
    const files = await fs.readdir(path.join(dataDir, PROJECT));
    expect(files).toContain("tasks.json");
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("serialises concurrent mutations instead of losing one", async () => {
    const { createTask, listTasks } = await load();
    await Promise.all([
      createTask(PROJECT, "scene_batch", entries(1)),
      createTask(PROJECT, "canvas_run", entries(1)),
      createTask(PROJECT, "planning", entries(1)),
    ]);
    expect(await listTasks(PROJECT)).toHaveLength(3);
  });
});

/** §15: a corrupt task file is quarantined without losing the project. */
describe("corruption handling", () => {
  it("quarantines an unparseable file and carries on", async () => {
    const { createTask, listTasks } = await load();
    await createTask(PROJECT, "scene_batch", entries(1));
    await fs.writeFile(taskFile(), "{ not json", "utf8");

    const fresh = await load();
    expect(await fresh.listTasks(PROJECT)).toEqual([]);

    const parked = (await fs.readdir(path.join(dataDir, PROJECT))).filter((f) =>
      f.startsWith("tasks.corrupt-"),
    );
    // Moved aside, not deleted: the operator keeps the evidence.
    expect(parked).toHaveLength(1);
  });

  it("quarantines a file that parses but does not match the schema", async () => {
    await fs.mkdir(path.join(dataDir, PROJECT), { recursive: true });
    await fs.writeFile(taskFile(), JSON.stringify({ tasks: "not an array" }), "utf8");
    const { listTasks } = await load();
    expect(await listTasks(PROJECT)).toEqual([]);
    const parked = (await fs.readdir(path.join(dataDir, PROJECT))).filter((f) =>
      f.startsWith("tasks.corrupt-"),
    );
    expect(parked).toHaveLength(1);
  });

  it("refuses a file written by a newer build rather than downgrading it", async () => {
    await fs.mkdir(path.join(dataDir, PROJECT), { recursive: true });
    await fs.writeFile(
      taskFile(),
      JSON.stringify({ schemaVersion: 99, revision: 3, tasks: [] }),
      "utf8",
    );
    const { listTasks } = await load();
    expect(await listTasks(PROJECT)).toEqual([]);
    const parked = (await fs.readdir(path.join(dataDir, PROJECT))).filter((f) =>
      f.startsWith("tasks.corrupt-"),
    );
    expect(parked).toHaveLength(1);
  });
});

/** FR-10: one drainer, even after an HMR reload. */
describe("worker lease", () => {
  it("grants the lease to the first caller", async () => {
    const { acquireLease } = await load();
    expect(await acquireLease(PROJECT)).toBe(true);
  });

  it("is reentrant for the same worker, so a renewal is not a conflict", async () => {
    const { acquireLease } = await load();
    expect(await acquireLease(PROJECT)).toBe(true);
    expect(await acquireLease(PROJECT)).toBe(true);
  });

  it("refuses a second worker while the lease is live", async () => {
    const first = await load();
    expect(await first.acquireLease(PROJECT)).toBe(true);

    // A fresh module graph mints a new worker id, which is what a second
    // drainer after a hot reload looks like.
    const second = await load();
    expect(await second.acquireLease(PROJECT)).toBe(false);
  });

  it("lets a new worker reclaim a lease left behind by a crash", async () => {
    const first = await load();
    await first.acquireLease(PROJECT);

    const raw = JSON.parse(await fs.readFile(taskFile(), "utf8"));
    raw.lease.heldUntil = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(taskFile(), JSON.stringify(raw), "utf8");

    const second = await load();
    expect(await second.acquireLease(PROJECT)).toBe(true);
  });

  it("frees the lease on release", async () => {
    const first = await load();
    await first.acquireLease(PROJECT);
    await first.releaseLease(PROJECT);
    const second = await load();
    expect(await second.acquireLease(PROJECT)).toBe(true);
  });

  it("is per project, so two projects can drain at once", async () => {
    const { acquireLease } = await load();
    expect(await acquireLease("p1")).toBe(true);
    expect(await acquireLease("p2")).toBe(true);
  });
});

/**
 * FR-11: a restart between backend acceptance and job-id persistence must not
 * auto-resubmit. This simulates each window by writing the state a crash would
 * have left, then restarting.
 */
describe("restart windows", () => {
  it("marks an entry caught mid-submission as submission_unknown", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", entries(1));
    const entryId = task.entries[0].id;
    await first.moveEntry(PROJECT, task.id, entryId, "submitting");

    const second = await load();
    const counts = await second.reconcileProject(PROJECT);
    expect(counts.unknown).toBe(1);

    const [reloaded] = await second.listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("submission_unknown");
    // Never pending: that would resubmit a job the backend may already hold.
    expect(reloaded.entries[0].state).not.toBe("pending");
  });

  it("reconciles a running entry that has a job id, rather than resubmitting", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", entries(1));
    const entryId = task.entries[0].id;
    await first.moveEntry(PROJECT, task.id, entryId, "submitting");
    await first.moveEntry(PROJECT, task.id, entryId, "submitted", { externalJobId: "wangp-7" });
    await first.moveEntry(PROJECT, task.id, entryId, "running");

    const second = await load();
    const counts = await second.reconcileProject(PROJECT);
    expect(counts.reconciling).toBe(1);
    const [reloaded] = await second.listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("reconciling");
    expect(reloaded.entries[0].externalJobId).toBe("wangp-7");
  });

  it("interrupts a running entry with no job id to poll", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", entries(1));
    const entryId = task.entries[0].id;
    await first.moveEntry(PROJECT, task.id, entryId, "submitting");
    await first.moveEntry(PROJECT, task.id, entryId, "submitted");
    await first.moveEntry(PROJECT, task.id, entryId, "running");

    const second = await load();
    expect((await second.reconcileProject(PROJECT)).interrupted).toBe(1);
  });

  it("leaves completed and pending work untouched across a restart", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", entries(2));
    await first.moveEntry(PROJECT, task.id, task.entries[0].id, "submitting");
    await first.moveEntry(PROJECT, task.id, task.entries[0].id, "submitted");
    await first.moveEntry(PROJECT, task.id, task.entries[0].id, "running");
    await first.moveEntry(PROJECT, task.id, task.entries[0].id, "completed");

    const second = await load();
    const counts = await second.reconcileProject(PROJECT);
    expect(counts).toEqual({ reconciling: 0, interrupted: 0, unknown: 0 });
    const [reloaded] = await second.listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("completed");
    expect(reloaded.entries[1].state).toBe("pending");
  });

  it("clears a stale lease during reconciliation", async () => {
    const first = await load();
    await first.createTask(PROJECT, "scene_batch", entries(1));
    await first.acquireLease(PROJECT);

    const second = await load();
    await second.reconcileProject(PROJECT);
    expect(await second.acquireLease(PROJECT)).toBe(true);
  });
});

describe("operator actions", () => {
  it("cancels pending work outright but only requests a stop for work in flight", async () => {
    const { createTask, moveEntry, requestCancel, listTasks } = await load();
    const task = await createTask(PROJECT, "scene_batch", entries(2));
    await moveEntry(PROJECT, task.id, task.entries[0].id, "submitting");
    await moveEntry(PROJECT, task.id, task.entries[0].id, "submitted", { externalJobId: "w1" });
    await moveEntry(PROJECT, task.id, task.entries[0].id, "running");

    await requestCancel(PROJECT);
    const [reloaded] = await listTasks(PROJECT);
    // The GPU job is still running; calling it cancelled would be a lie.
    expect(reloaded.entries[0].state).toBe("cancel_requested");
    expect(reloaded.entries[1].state).toBe("cancelled");
  });

  it("retries failed and interrupted work while keeping the diagnosis", async () => {
    const { createTask, moveEntry, retryEntries, listTasks } = await load();
    const task = await createTask(PROJECT, "scene_batch", entries(1));
    const id = task.entries[0].id;
    await moveEntry(PROJECT, task.id, id, "submitting");
    await moveEntry(PROJECT, task.id, id, "submitted");
    await moveEntry(PROJECT, task.id, id, "running");
    await moveEntry(PROJECT, task.id, id, "failed", { detail: "CUDA out of memory" });

    expect(await retryEntries(PROJECT, task.id)).toBe(1);
    const [reloaded] = await listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("pending");
    expect(reloaded.entries[0].history.some((h) => h.detail?.includes("CUDA"))).toBe(true);
  });

  it("lets an operator stop tracking a job that may still be running", async () => {
    const { createTask, moveEntry, stopTracking, listTasks } = await load();
    const task = await createTask(PROJECT, "scene_batch", entries(1));
    const id = task.entries[0].id;
    await moveEntry(PROJECT, task.id, id, "submitting");
    await stopTracking(PROJECT, task.id);
    const [reloaded] = await listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("stop_tracking");
  });

  it("dismisses finished tasks but never unresolved ones", async () => {
    const { createTask, moveEntry, dismissCompleted, listTasks } = await load();
    const done = await createTask(PROJECT, "canvas_run", entries(1));
    await moveEntry(PROJECT, done.id, done.entries[0].id, "submitting");
    await moveEntry(PROJECT, done.id, done.entries[0].id, "submitted");
    await moveEntry(PROJECT, done.id, done.entries[0].id, "running");
    await moveEntry(PROJECT, done.id, done.entries[0].id, "completed");

    const stuck = await createTask(PROJECT, "scene_batch", entries(1));
    await moveEntry(PROJECT, stuck.id, stuck.entries[0].id, "submitting");
    await (await load()).reconcileProject(PROJECT);

    const after = await load();
    await after.dismissCompleted(PROJECT);
    const remaining = await after.listTasks(PROJECT);
    expect(remaining.map((t) => t.id)).toEqual([stuck.id]);
  });
});

/** FR-9: bounded storage, but never at the cost of losing an unresolved job. */
describe("retention", () => {
  it("prunes old finished tasks once over the cap", async () => {
    const { createTask, moveEntry, listTasks } = await load();
    const { MAX_TASKS_PER_PROJECT } = await import("@/lib/schemas/tasks");

    for (let i = 0; i < MAX_TASKS_PER_PROJECT + 5; i += 1) {
      const task = await createTask(PROJECT, "canvas_run", entries(1));
      const id = task.entries[0].id;
      await moveEntry(PROJECT, task.id, id, "submitting");
      await moveEntry(PROJECT, task.id, id, "submitted");
      await moveEntry(PROJECT, task.id, id, "running");
      await moveEntry(PROJECT, task.id, id, "completed");
    }
    expect((await listTasks(PROJECT)).length).toBeLessThanOrEqual(MAX_TASKS_PER_PROJECT);
  });

  it("never prunes a task awaiting an operator, however old", async () => {
    const first = await load();
    const { MAX_TASKS_PER_PROJECT } = await import("@/lib/schemas/tasks");

    const stranded = await first.createTask(PROJECT, "scene_batch", entries(1));
    await first.moveEntry(PROJECT, stranded.id, stranded.entries[0].id, "submitting");
    await (await load()).reconcileProject(PROJECT);

    const after = await load();
    for (let i = 0; i < MAX_TASKS_PER_PROJECT + 5; i += 1) {
      const task = await after.createTask(PROJECT, "canvas_run", entries(1));
      const id = task.entries[0].id;
      await after.moveEntry(PROJECT, task.id, id, "submitting");
      await after.moveEntry(PROJECT, task.id, id, "submitted");
      await after.moveEntry(PROJECT, task.id, id, "running");
      await after.moveEntry(PROJECT, task.id, id, "completed");
    }

    const tasks = await after.listTasks(PROJECT);
    // It is the only record that a GPU job may still be out there.
    expect(tasks.some((t) => t.id === stranded.id)).toBe(true);
  });
});
