import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Restart behaviour with a fake backend job (SPEC-008 §15).
 *
 * No live jobs: the point is the *window* between the backend accepting work
 * and us persisting its id, which is reproduced by driving the state machine
 * to that point and then reloading with empty globals.
 */

let dataDir: string;

async function load() {
  vi.resetModules();
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.__storyforgeTaskRepo;
  delete globals.__storyforgeWorkerId;
  delete globals.__storyforgeDurableDrains;
  process.env.STORYFORGE_DATA_DIR = dataDir;
  process.env.STORYFORGE_PERSISTENCE = "file";
  process.env.DURABLE_TASKS = "true";
  return {
    ...(await import("@/lib/tasks/task-service")),
    ...(await import("@/lib/tasks/drainer")),
    ...(await import("@/lib/tasks/startup")),
  };
}

const saved = {
  dir: process.env.STORYFORGE_DATA_DIR,
  persistence: process.env.STORYFORGE_PERSISTENCE,
  durable: process.env.DURABLE_TASKS,
};

beforeEach(async () => {
  dataDir = path.join(os.tmpdir(), `sf-restart-${randomUUID()}`);
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  for (const [key, value] of [
    ["STORYFORGE_DATA_DIR", saved.dir],
    ["STORYFORGE_PERSISTENCE", saved.persistence],
    ["DURABLE_TASKS", saved.durable],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

const PROJECT = "p1";
const scenes = [
  { ref: "p1-scene-001", label: "Scene 1", order: 1 },
  { ref: "p1-scene-002", label: "Scene 2", order: 2 },
];

/** A backend that accepts jobs and can be asked about them afterwards. */
function fakeBackend() {
  const jobs = new Map<string, "running" | "completed" | "failed">();
  return {
    submit(): string {
      const id = `wangp-${jobs.size + 1}`;
      jobs.set(id, "running");
      return id;
    },
    finish(id: string) {
      jobs.set(id, "completed");
    },
    forget(id: string) {
      jobs.delete(id);
    },
    status(id: string) {
      return jobs.get(id) ?? "unknown";
    },
  };
}

describe("the submit window", () => {
  it("leaves an entry recoverable once the job id is persisted", async () => {
    const backend = fakeBackend();
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", scenes);
    const id = task.entries[0].id;

    await first.moveEntry(PROJECT, task.id, id, "submitting");
    const jobId = backend.submit();
    await first.moveEntry(PROJECT, task.id, id, "submitted", { externalJobId: jobId });
    await first.moveEntry(PROJECT, task.id, id, "running");

    // Process dies here.
    const second = await load();
    await second.reconcileStartup();
    const [reloaded] = await second.listTasks(PROJECT);

    expect(reloaded.entries[0].state).toBe("reconciling");
    expect(reloaded.entries[0].externalJobId).toBe(jobId);
    // The job is still out there and can be asked about.
    expect(backend.status(jobId)).toBe("running");
  });

  it("refuses to resubmit when the crash landed inside the window", async () => {
    const backend = fakeBackend();
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", scenes);
    const id = task.entries[0].id;

    // Intent persisted, backend accepted, id NOT yet written — the exact
    // interval FR-11 is about.
    await first.moveEntry(PROJECT, task.id, id, "submitting");
    const orphan = backend.submit();

    const second = await load();
    await second.reconcileStartup();
    const [reloaded] = await second.listTasks(PROJECT);

    expect(reloaded.entries[0].state).toBe("submission_unknown");
    expect(reloaded.entries[0].state).not.toBe("pending");
    // The orphaned job is still running and we have no id for it, which is
    // precisely why a human has to decide.
    expect(backend.status(orphan)).toBe("running");
  });

  it("does not treat an ambiguous entry as work a drainer may pick up", async () => {
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", scenes);
    await first.moveEntry(PROJECT, task.id, task.entries[0].id, "submitting");

    const second = await load();
    await second.reconcileStartup();
    const { isActive } = await import("@/lib/schemas/tasks");
    const [reloaded] = await second.listTasks(PROJECT);
    expect(isActive(reloaded.entries[0].state)).toBe(false);
  });
});

describe("resuming after reconciliation", () => {
  it("completes an entry whose backend job finished while we were down", async () => {
    const backend = fakeBackend();
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", scenes);
    const id = task.entries[0].id;
    await first.moveEntry(PROJECT, task.id, id, "submitting");
    const jobId = backend.submit();
    await first.moveEntry(PROJECT, task.id, id, "submitted", { externalJobId: jobId });
    await first.moveEntry(PROJECT, task.id, id, "running");

    backend.finish(jobId);

    const second = await load();
    await second.reconcileStartup();

    const submitted: string[] = [];
    await second.drainTask(PROJECT, task.id, {
      runEntry: async (entry) => {
        submitted.push(entry.ref);
        return { kind: "completed" };
      },
      reconcileEntry: async (entry) =>
        backend.status(entry.externalJobId!) === "completed"
          ? { kind: "completed" as const }
          : "unknown",
    });

    const [reloaded] = await second.listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("completed");
    // Resumed by polling, never resubmitted (FR-4).
    expect(submitted).not.toContain("p1-scene-001");
    // The second scene never started, so running it is safe.
    expect(submitted).toContain("p1-scene-002");
  });

  it("interrupts an entry the backend has forgotten", async () => {
    const backend = fakeBackend();
    const first = await load();
    const task = await first.createTask(PROJECT, "scene_batch", [scenes[0]]);
    const id = task.entries[0].id;
    await first.moveEntry(PROJECT, task.id, id, "submitting");
    const jobId = backend.submit();
    await first.moveEntry(PROJECT, task.id, id, "submitted", { externalJobId: jobId });
    await first.moveEntry(PROJECT, task.id, id, "running");
    backend.forget(jobId);

    const second = await load();
    await second.reconcileStartup();
    await second.drainTask(PROJECT, task.id, {
      runEntry: async () => ({ kind: "completed" }),
      reconcileEntry: async () => "unknown",
    });

    const [reloaded] = await second.listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("interrupted");
  });
});

describe("the drainer records intent before touching the backend", () => {
  it("moves through submitting before the work begins", async () => {
    const { createTask, drainTask, listTasks } = await load();
    const task = await createTask(PROJECT, "scene_batch", [scenes[0]]);

    await drainTask(PROJECT, task.id, {
      runEntry: async (_entry, hooks) => {
        await hooks.onSubmitted("wangp-42");
        return { kind: "completed" };
      },
    });

    const [reloaded] = await listTasks(PROJECT);
    const states = reloaded.entries[0].history.map((h) => h.to);
    // Intent is on disk before anything non-idempotent happens.
    expect(states).toEqual(["submitting", "submitted", "running", "completed"]);
    expect(reloaded.entries[0].externalJobId).toBe("wangp-42");
  });

  it("still finishes cleanly when the work reports no job id", async () => {
    const { createTask, drainTask, listTasks } = await load();
    const task = await createTask(PROJECT, "canvas_run", [scenes[0]]);
    await drainTask(PROJECT, task.id, { runEntry: async () => ({ kind: "completed" }) });
    const [reloaded] = await listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("completed");
  });

  it("records a failure without losing the diagnosis", async () => {
    const { createTask, drainTask, listTasks } = await load();
    const task = await createTask(PROJECT, "scene_batch", [scenes[0]]);
    await drainTask(PROJECT, task.id, {
      runEntry: async () => ({ kind: "failed", detail: "CUDA out of memory", retryable: true }),
    });
    const [reloaded] = await listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("failed");
    expect(reloaded.entries[0].error).toContain("CUDA");
  });

  it("stops the run at the first failure when the caller asks it to", async () => {
    const { createTask, drainTask, listTasks } = await load();
    const task = await createTask(PROJECT, "canvas_run", scenes);
    await drainTask(PROJECT, task.id, {
      abortOnFailure: true,
      runEntry: async () => ({ kind: "failed", detail: "nope", retryable: false }),
    });
    const [reloaded] = await listTasks(PROJECT);
    expect(reloaded.entries[0].state).toBe("failed");
    expect(reloaded.entries[1].state).toBe("pending");
  });
});

/** FR-10: one drainer per project, however many callers ask. */
describe("drain concurrency", () => {
  it("runs one drainer when two callers start at once", async () => {
    const { createTask, drainTask } = await load();
    const task = await createTask(PROJECT, "scene_batch", scenes);

    let concurrent = 0;
    let peak = 0;
    const runEntry = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
      return { kind: "completed" as const };
    };

    await Promise.all([
      drainTask(PROJECT, task.id, { runEntry }),
      drainTask(PROJECT, task.id, { runEntry }),
    ]);

    expect(peak).toBe(1);
  });

  it("lets two projects drain at the same time", async () => {
    const { createTask, drainTask, listTasks } = await load();
    const a = await createTask("p1", "scene_batch", [scenes[0]]);
    const b = await createTask("p2", "scene_batch", [{ ...scenes[0], ref: "p2-scene-001" }]);

    await Promise.all([
      drainTask("p1", a.id, { runEntry: async () => ({ kind: "completed" }) }),
      drainTask("p2", b.id, { runEntry: async () => ({ kind: "completed" }) }),
    ]);

    expect((await listTasks("p1"))[0].entries[0].state).toBe("completed");
    expect((await listTasks("p2"))[0].entries[0].state).toBe("completed");
  });

  it("skips draining when another worker holds the lease", async () => {
    const holder = await load();
    const task = await holder.createTask(PROJECT, "scene_batch", scenes);
    await holder.acquireLease(PROJECT);

    // A different worker id is what a second process looks like.
    const other = await load();
    let ran = false;
    await other.drainTask(PROJECT, task.id, {
      runEntry: async () => {
        ran = true;
        return { kind: "completed" };
      },
    });
    expect(ran).toBe(false);
  });
});
