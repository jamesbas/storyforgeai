import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * The Scheduler's worker, against queues it can see but not drive.
 *
 * The canvas and scene queues are replaced with fakes so each test decides when
 * a run finishes and how. What is under test is the sequencing on top: one item
 * at a time, waiting behind the GPU, the failure policy, pause, cancel, and that
 * nothing runs — not even a timer — unless the schedule is running.
 */

type Entry = { state: string; agentName?: string; sceneNumber?: number; error?: string };
type Run = { active: boolean; entries: Entry[] };

const fake = vi.hoisted(() => ({
  busy: false,
  wangpOk: true,
  wangpGate: null as Promise<void> | null,
  records: new Map<string, unknown>(),
  canvas: new Map<string, { active: boolean; entries: { state: string; agentName?: string; error?: string }[] }>(),
  scenes: new Map<string, { active: boolean; entries: { state: string; sceneNumber?: number; error?: string }[] }>(),
  dispatched: [] as string[],
  restarts: 0,
  cancelled: [] as string[],
}));

vi.mock("@/lib/services/project-service", async () => {
  const { NotFoundError } = await import("@/lib/errors");
  return {
    getProjectRecord: async (id: string) => {
      const record = fake.records.get(id);
      if (!record) throw new NotFoundError(`Project ${id} not found`);
      return structuredClone(record);
    },
  };
});

vi.mock("@/lib/db/store", () => ({
  repository: {
    get: async (id: string) => fake.records.get(id) ?? null,
    list: async () => [...fake.records.values()],
  },
}));

vi.mock("@/lib/services/media-service", () => ({
  chosenAttempt: () => undefined,
}));

vi.mock("@/lib/services/canvas-queue", () => ({
  enqueueCanvasRun: (id: string) => {
    fake.dispatched.push(`storyboard:${id}`);
    fake.canvas.set(id, { active: true, entries: [{ state: "running", agentName: "World Builder" }] });
  },
  getCanvasQueue: (id: string) => {
    const run = fake.canvas.get(id) ?? { active: false, entries: [] };
    return { ...run, done: run.entries.filter((e) => e.state === "completed").length, total: run.entries.length };
  },
  cancelCanvasRun: (id: string) => {
    fake.cancelled.push(`storyboard:${id}`);
  },
  activeCanvasProjects: () => [],
}));

vi.mock("@/lib/services/scene-queue", () => {
  const start = (kind: string, id: string) => {
    fake.dispatched.push(`${kind}:${id}`);
    fake.scenes.set(id, { active: true, entries: [{ state: "running", sceneNumber: 1 }] });
    return [{}];
  };
  return {
    enqueueSceneRun: async (id: string) => ({ entries: start("video", id), cascaded: false, skippedFinished: 0 }),
    enqueueKeyframeRerun: async (id: string) => ({ entries: start("keyframes", id), followOn: [] }),
    getQueue: (id: string) => fake.scenes.get(id) ?? { active: false, entries: [] },
    clearFinished: () => undefined,
    cancelQueue: (id: string) => {
      fake.cancelled.push(`scenes:${id}`);
      return 0;
    },
    missingKeyframeSceneIds: (record: { storyboard?: { scenes: { id: string }[] } }) =>
      (record.storyboard?.scenes ?? []).map((scene) => scene.id),
    videoRerunScope: (_record: unknown, ids: string[]) => ({ sceneIds: ids, cascaded: false }),
    activeSceneQueueProjects: () => [],
  };
});

vi.mock("@/lib/services/canvas-task-queue", () => ({
  enqueueDurableCanvasRun: async () => ({ id: "t", entries: [] }),
  cancelDurableCanvasRun: async () => 0,
}));

vi.mock("@/lib/services/scene-task-queue", () => ({
  enqueueDurableSceneBatch: async () => ({ id: "t", entries: [] }),
  cancelDurableSceneBatch: async () => 0,
}));

vi.mock("@/lib/tasks/task-service", () => ({ listTasks: async () => [] }));

vi.mock("@/lib/services/generation-busy", () => ({
  isGenerationBusy: () => fake.busy,
  describeBusy: async () => (fake.busy ? "Scene render — Manual" : null),
}));

vi.mock("@/lib/services/wangp-service", () => ({
  getWangpStatus: async () => {
    if (fake.wangpGate) await fake.wangpGate;
    return { enabled: true, mode: "live", url: "", ok: fake.wangpOk, filesystemReads: true };
  },
}));

vi.mock("@/lib/services/wangp-restart-service", () => ({
  restartWangp: async () => {
    fake.restarts += 1;
    return { outcome: "restarted", seconds: 1 };
  },
  wangpRestartAvailable: async () => true,
}));

vi.mock("@/lib/services/llm-runtime-service", () => ({
  getLlmRuntimeStatus: async () => ({ configuredModelLoaded: true }),
  loadPlanningModel: async () => ({}),
}));

const scheduler = () => import("@/lib/services/scheduler-service");

function record(id: string, overrides: { mode?: string; storyboard?: boolean; scenes?: number } = {}): ProjectRecord {
  const scenes = Array.from({ length: overrides.scenes ?? 3 }, (_, i) => ({
    id: `${id}-${i + 1}`,
    sceneNumber: i + 1,
    title: `Scene ${i + 1}`,
  }));
  return {
    project: {
      id,
      title: `Project ${id}`,
      generationMode: overrides.mode ?? "video_segments",
      sceneContinuity: "cut",
    },
    ...(overrides.storyboard === false ? {} : { storyboard: { scenes } }),
    attempts: {},
  } as unknown as ProjectRecord;
}

function seed(...records: ProjectRecord[]) {
  for (const r of records) fake.records.set(r.project.id, r);
}

async function revision(): Promise<number> {
  const { scheduleStore } = await import("@/lib/db/schedule-store");
  return (await scheduleStore().read()).revision;
}

async function schedule() {
  const { scheduleStore } = await import("@/lib/db/schedule-store");
  return scheduleStore().read();
}

async function add(projectId: string, runType: string, extra: Record<string, unknown> = {}) {
  const { addScheduleItem } = await scheduler();
  return (await addScheduleItem({ projectId, runType, ...extra }, await revision())).item;
}

async function act(action: string) {
  const { scheduleAction } = await scheduler();
  return scheduleAction(action, await revision());
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Condition not met in time");
}

function finish(kind: "canvas" | "scenes", id: string, states: string[]) {
  const run: Run = {
    active: false,
    entries: states.map((state, i) => ({
      state,
      sceneNumber: i + 1,
      agentName: `Agent ${i + 1}`,
      error: state === "failed" ? "boom" : undefined,
    })),
  };
  (kind === "canvas" ? fake.canvas : fake.scenes).set(id, run);
}

const itemState = async (id: string) => (await schedule()).items.find((item) => item.id === id);

beforeEach(async () => {
  Object.assign(fake, { busy: false, wangpOk: true, restarts: 0, wangpGate: null });
  fake.records.clear();
  fake.canvas.clear();
  fake.scenes.clear();
  fake.dispatched.length = 0;
  fake.cancelled.length = 0;
  const { setScheduleStore, createMemoryScheduleStore } = await import("@/lib/db/schedule-store");
  setScheduleStore(createMemoryScheduleStore());
  (await import("@/lib/services/scheduler-state")).resetSchedulerRuntime();
  (await scheduler()).setSchedulerTiming({ followMs: 2, settleMs: 0 });
});

afterEach(async () => {
  vi.useRealTimers();
  // Never leave a loop running into the next test.
  const { schedulerRuntime } = await import("@/lib/services/scheduler-state");
  if (schedulerRuntime().loopActive) {
    await act("pause").catch(() => undefined);
    for (const run of [...fake.canvas.values(), ...fake.scenes.values()]) run.active = false;
    await waitFor(() => !schedulerRuntime().loopActive);
  }
});

describe("running the schedule", () => {
  it("runs items strictly one at a time, in order", async () => {
    seed(record("a"), record("b"), record("c"));
    const first = await add("a", "video");
    const second = await add("b", "storyboard");
    const third = await add("c", "keyframes");
    await act("start");

    await waitFor(() => fake.dispatched.length === 1);
    expect(fake.dispatched).toEqual(["video:a"]);
    expect((await itemState(first.id))?.state).toBe("running");
    expect((await itemState(second.id))?.state).toBe("queued");

    finish("scenes", "a", ["completed", "completed"]);
    await waitFor(() => fake.dispatched.length === 2);
    expect(fake.dispatched[1]).toBe("storyboard:b");
    expect((await itemState(first.id))?.state).toBe("completed");

    finish("canvas", "b", ["completed"]);
    await waitFor(() => fake.dispatched.length === 3);
    finish("scenes", "c", ["completed"]);
    await waitFor(async () => (await schedule()).state === "completed");

    const done = await schedule();
    expect(done.items.map((item) => item.state)).toEqual(["completed", "completed", "completed"]);
    expect(done.items[0]!.finishedAt! <= done.items[1]!.startedAt!).toBe(true);
    expect((await itemState(third.id))?.summary?.completed).toBe(1);
  });

  it("waits behind a run already on the GPU when started, then dispatches", async () => {
    seed(record("a"));
    fake.busy = true;
    await add("a", "video");
    await act("start");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.dispatched).toEqual([]);
    const { getSchedulerSnapshot } = await scheduler();
    expect((await getSchedulerSnapshot()).waitingFor).toBe("Scene render — Manual");

    fake.busy = false;
    await waitFor(() => fake.dispatched.length === 1);
    expect((await schedule()).items[0]!.waitedSeconds).toBeGreaterThanOrEqual(0);
  });

  it("finishes the running item on pause and starts nothing more", async () => {
    seed(record("a"), record("b"));
    const first = await add("a", "video");
    const second = await add("b", "video");
    await act("start");
    await waitFor(() => fake.dispatched.length === 1);

    await act("pause");
    finish("scenes", "a", ["completed"]);
    const { schedulerRuntime } = await import("@/lib/services/scheduler-state");
    await waitFor(() => !schedulerRuntime().loopActive);

    expect(fake.dispatched).toEqual(["video:a"]);
    expect((await itemState(first.id))?.state).toBe("completed");
    expect((await itemState(second.id))?.state).toBe("queued");
    expect((await schedule()).state).toBe("paused");
  });

  it("cancels only the current item's pending units, then carries on", async () => {
    seed(record("a"), record("b"));
    const first = await add("a", "video");
    await add("b", "storyboard");
    await act("start");
    await waitFor(() => fake.dispatched.length === 1);

    await act("cancelCurrent");
    expect(fake.cancelled).toEqual(["scenes:a"]);
    finish("scenes", "a", ["completed", "cancelled"]);

    await waitFor(() => fake.dispatched.length === 2);
    expect((await itemState(first.id))?.state).toBe("cancelled");
  });

  it("holds no timer unless the schedule is running", async () => {
    vi.useFakeTimers();
    seed(record("a"));
    await add("a", "video");
    expect(vi.getTimerCount()).toBe(0);

    fake.busy = true;
    await act("start");
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(1);

    await act("pause");
    await vi.advanceTimersByTimeAsync(10);
    const { schedulerRuntime } = await import("@/lib/services/scheduler-state");
    expect(schedulerRuntime().loopActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("failure policy", () => {
  it("counts scenes cancelled from the Storyboard screen as a cancelled item", async () => {
    seed(record("a"));
    const only = await add("a", "video");
    await act("start");
    await waitFor(() => fake.dispatched.length === 1);
    finish("scenes", "a", ["completed", "cancelled"]);
    await waitFor(async () => (await schedule()).state === "completed");
    expect((await itemState(only.id))?.state).toBe("cancelled");
  });

  it("skips only the failed project's later items", async () => {
    seed(record("a"), record("b"));
    await add("a", "storyboard");
    const sameProject = await add("a", "keyframes");
    const other = await add("b", "video");
    await act("start");

    await waitFor(() => fake.dispatched.length === 1);
    finish("canvas", "a", ["completed", "failed", "cancelled"]);
    await waitFor(() => fake.dispatched.length === 2);

    expect(fake.dispatched[1]).toBe("video:b");
    const skipped = await itemState(sameProject.id);
    expect(skipped?.state).toBe("skipped");
    expect(skipped?.reason).toMatch(/Storyboard run for this project failed/);
    finish("scenes", "b", ["completed"]);
    await waitFor(async () => (await itemState(other.id))?.state === "completed");
    expect((await schedule()).items[0]!.state).toBe("failed");
  });

  it("skips nothing after a run that only partly failed", async () => {
    seed(record("a"));
    const first = await add("a", "keyframes");
    const second = await add("a", "video");
    await act("start");

    await waitFor(() => fake.dispatched.length === 1);
    finish("scenes", "a", ["completed", "failed"]);
    await waitFor(() => fake.dispatched.length === 2);

    expect((await itemState(first.id))?.state).toBe("completed_with_errors");
    expect((await itemState(second.id))?.state).toBe("running");
  });

  it("fails a media item whose every scene failed", async () => {
    seed(record("a"));
    const only = await add("a", "video");
    await act("start");
    await waitFor(() => fake.dispatched.length === 1);
    finish("scenes", "a", ["failed", "failed"]);
    await waitFor(async () => (await schedule()).state === "completed");
    expect((await itemState(only.id))?.state).toBe("failed");
  });
});

describe("GPU handoff", () => {
  it("skips a media item when WanGP is unreachable, without enqueueing anything", async () => {
    seed(record("a"));
    fake.wangpOk = false;
    const item = await add("a", "video");
    await act("start");
    await waitFor(async () => (await schedule()).state === "completed");

    expect(fake.dispatched).toEqual([]);
    expect((await itemState(item.id))?.state).toBe("skipped");
    expect((await itemState(item.id))?.reason).toMatch(/WanGP is not reachable/);
  });

  it("restarts WanGP only before a storyboard that follows a render", async () => {
    seed(record("a"), record("b"));
    await add("a", "storyboard");
    await add("a", "video");
    const after = await add("b", "storyboard");
    await act("start");

    await waitFor(() => fake.dispatched.length === 1);
    expect(fake.restarts).toBe(0);
    finish("canvas", "a", ["completed"]);
    await waitFor(() => fake.dispatched.length === 2);
    finish("scenes", "a", ["completed"]);
    await waitFor(() => fake.dispatched.length === 3);

    expect(fake.restarts).toBe(1);
    expect((await itemState(after.id))?.preparation?.wangpRestart?.outcome).toBe("restarted");
    finish("canvas", "b", ["completed"]);
  });
});

describe("validation", () => {
  it("refuses a stage the project's generation mode forbids", async () => {
    seed(record("a", { mode: "storyboard_only" }), record("b", { mode: "keyframes_only" }));
    await expect(add("a", "keyframes")).rejects.toThrow(/Storyboard only/);
    await expect(add("b", "video")).rejects.toThrow(/Keyframes only/);
    await expect(add("b", "keyframes")).resolves.toMatchObject({ state: "queued" });
  });

  it("allows a project without a storyboard only behind a storyboard item for it", async () => {
    seed(record("a", { storyboard: false }));
    expect((await add("a", "video")).state).toBe("invalid");
    await add("a", "storyboard");
    expect((await add("a", "video")).state).toBe("queued");
  });

  it("marks picked scenes invalid behind a same-project storyboard, on add and on reorder", async () => {
    seed(record("a"));
    const picked = await add("a", "keyframes", { scope: { mode: "selected", sceneIds: ["a-2"] } });
    expect(picked.state).toBe("queued");
    expect(picked.scope).toMatchObject({ sceneNumbers: [2] });

    const storyboard = await add("a", "storyboard");
    expect((await add("a", "video", { scope: { mode: "selected", sceneIds: ["a-1"] } })).state).toBe("invalid");

    const { scheduleItemAction } = await scheduler();
    await scheduleItemAction(storyboard.id, "moveUp", await revision());
    expect((await itemState(picked.id))?.state).toBe("invalid");
    await expect(act("start")).rejects.toThrow(/Fix the invalid item first/);
  });

  it("refuses a stale revision", async () => {
    seed(record("a"));
    const { addScheduleItem } = await scheduler();
    const stale = await revision();
    await add("a", "video");
    await expect(addScheduleItem({ projectId: "a", runType: "video" }, stale)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("drops picked scenes that no longer exist at dispatch, and skips when none are left", async () => {
    seed(record("a"), record("b"));
    const some = await add("a", "video", { scope: { mode: "selected", sceneIds: ["a-1", "a-3"] } });
    const none = await add("b", "video", { scope: { mode: "selected", sceneIds: ["b-2"] } });
    seed(record("a", { scenes: 2 }), record("b", { scenes: 1 }));
    await act("start");

    await waitFor(() => fake.dispatched.length === 1);
    finish("scenes", "a", ["completed"]);
    await waitFor(async () => (await schedule()).state === "completed");

    expect((await itemState(some.id))?.summary?.droppedScenes).toEqual([3]);
    expect((await itemState(none.id))?.state).toBe("skipped");
    expect(fake.dispatched).toEqual(["video:a"]);
  });

  it("skips an item whose project was deleted", async () => {
    seed(record("a"));
    const item = await add("a", "video");
    fake.records.delete("a");
    const { getSchedulerSnapshot } = await scheduler();
    const snapshot = await getSchedulerSnapshot();
    expect(snapshot.schedule.items.find((i) => i.id === item.id)).toMatchObject({
      state: "skipped",
      reason: "Project was deleted.",
    });
  });

  it("requeues a finished item as a fresh copy at the end", async () => {
    seed(record("a"));
    fake.wangpOk = false;
    const item = await add("a", "video");
    await act("start");
    await waitFor(async () => (await schedule()).state === "completed");

    const { scheduleItemAction } = await scheduler();
    const next = await scheduleItemAction(item.id, "requeue", await revision());
    expect(next.items.map((i) => i.state)).toEqual(["skipped", "queued"]);
  });
});

describe("restart", () => {
  it("a cancel before dispatch never reaches the project's queue", async () => {
    seed(record("a"));
    let release!: () => void;
    fake.wangpGate = new Promise<void>((resolve) => (release = resolve));
    const item = await add("a", "video");
    await act("start");

    const { schedulerRuntime } = await import("@/lib/services/scheduler-state");
    await waitFor(() => schedulerRuntime().current !== null);
    await act("cancelCurrent");
    release();
    await waitFor(async () => (await schedule()).state === "completed");

    expect(fake.dispatched).toEqual([]);
    expect(fake.cancelled).toEqual([]);
    expect((await itemState(item.id))?.state).toBe("cancelled");
  });

  it("recovers from a failed schedule write without leaving the guard engaged", async () => {
    seed(record("a"));
    const { createMemoryScheduleStore, setScheduleStore } = await import("@/lib/db/schedule-store");
    const inner = createMemoryScheduleStore();
    let failFinish = true;
    setScheduleStore({
      read: () => inner.read(),
      mutate: (fn) =>
        inner.mutate(async (draft) => {
          const result = await fn(draft);
          // The write that records the outcome fails once, as a locked file would.
          if (failFinish && draft.items.some((i) => i.state === "completed")) {
            failFinish = false;
            throw new Error("EBUSY: resource busy or locked");
          }
          return result;
        }),
    });
    const item = await add("a", "video");
    await act("start");
    await waitFor(() => fake.dispatched.length === 1);
    finish("scenes", "a", ["completed"]);

    const { schedulerRuntime } = await import("@/lib/services/scheduler-state");
    await waitFor(() => !schedulerRuntime().loopActive);
    expect(schedulerRuntime().current).toBeNull();
    expect(await schedule()).toMatchObject({ state: "paused" });
    expect((await itemState(item.id))?.state).toBe("interrupted");
  });

  it("brings a running schedule back paused with the running item interrupted", async () => {
    seed(record("a"), record("b"));
    const { scheduleStore } = await import("@/lib/db/schedule-store");
    await scheduleStore().mutate((draft) => {
      draft.state = "running";
      draft.items = [
        { id: "x", projectId: "a", projectTitle: "Night Harbor", runType: "video", scope: { mode: "all" }, options: {}, state: "running", addedAt: "2026-01-01T00:00:00Z" },
        { id: "y", projectId: "b", projectTitle: "Other", runType: "storyboard", scope: { mode: "all" }, options: {}, state: "queued", addedAt: "2026-01-01T00:00:00Z" },
      ];
    });

    const { loadScheduleAtStartup } = await scheduler();
    await loadScheduleAtStartup();

    const after = await schedule();
    expect(after.state).toBe("paused");
    expect(after.items.map((i) => i.state)).toEqual(["interrupted", "queued"]);
    expect(after.restartNotice?.label).toBe("Video — Night Harbor");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dispatched).toEqual([]);
  });

  it("leaves other states unchanged", async () => {
    seed(record("a"));
    await add("a", "video");
    const before = await schedule();
    const { loadScheduleAtStartup } = await scheduler();
    await loadScheduleAtStartup();
    expect(await schedule()).toEqual(before);
  });
});

describe("with durable tasks on", () => {
  afterEach(() => {
    process.env.DURABLE_TASKS = "false";
    vi.resetModules();
  });

  it("refuses keyframe items and redo, and accepts storyboard and video", async () => {
    process.env.DURABLE_TASKS = "true";
    vi.resetModules();
    seed(record("a"));
    const { addScheduleItem } = await scheduler();
    const add2 = async (input: Record<string, unknown>) => addScheduleItem({ projectId: "a", ...input }, await revision());

    await expect(add2({ runType: "keyframes" })).rejects.toThrow(/not available with durable tasks/);
    await expect(add2({ runType: "video", options: { redoFinished: true } })).rejects.toThrow(/not available with durable tasks/);
    await expect(add2({ runType: "storyboard" })).resolves.toBeTruthy();
    await expect(add2({ runType: "video" })).resolves.toBeTruthy();
  });
});
