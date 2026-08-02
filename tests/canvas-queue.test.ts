import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The crew run belongs to the server, not to the page that started it.
 *
 * It used to be a loop in the browser: one fetch per agent, in order. Every
 * agent is minutes of work on a local model, so a refresh or a navigation
 * abandoned everything that had not started yet — silently, while the agent in
 * flight finished and kept the screen looking busy. These tests pin the
 * properties that made moving it worth doing.
 */

const runs: string[] = [];
let failOn: string | null = null;
let gate: (() => void) | null = null;

vi.mock("@/lib/services/project-service", () => {
  const record = (agent: string) => async (projectId: string) => {
    runs.push(`${agent}:${projectId}`);
    if (gate) await new Promise<void>((resolve) => (gate = resolve));
    if (failOn === agent) throw new Error(`${agent} exploded`);
    return {} as never;
  };
  return {
    generateWorldBible: record("world"),
    generateDirectorialPlan: record("director"),
    generateCinematographyPlan: record("cinematographer"),
    generateArtDirectionPlan: record("art"),
    generateStoryboard: record("storyboard"),
  };
});

async function queue() {
  return import("@/lib/services/canvas-queue");
}

/** The worker is async; let it settle rather than guessing at a delay. */
async function settle() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

beforeEach(async () => {
  runs.length = 0;
  failOn = null;
  gate = null;
  (await queue()).resetCanvasQueue();
});

afterEach(async () => {
  (await queue()).resetCanvasQueue();
});

describe("canvas run queue", () => {
  it("runs the crew in dependency order", async () => {
    const { enqueueCanvasRun } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();

    // The storyboard folds in whichever plans exist when it runs, so it is last.
    expect(runs).toEqual([
      "world:p1",
      "director:p1",
      "cinematographer:p1",
      "art:p1",
      "storyboard:p1",
    ]);
  });

  it("leaves the storyboard out when it was not asked for", async () => {
    const { enqueueCanvasRun } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();

    expect(runs).not.toContain("storyboard:p1");
    expect(runs).toHaveLength(4);
  });

  /**
   * The property the browser loop could not offer: the run does not need anyone
   * watching it.
   */
  it("keeps going with no client attached", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: true });
    // Nothing polls, nothing holds a reference; the queue owns the work.
    await settle();

    const state = getCanvasQueue("p1");
    expect(state.active).toBe(false);
    expect(state.done).toBe(5);
    expect(state.entries.every((e) => e.state === "completed")).toBe(true);
  });

  it("reports progress a page arriving mid-run can read", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    gate = () => undefined;
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();

    const state = getCanvasQueue("p1");
    expect(state.active).toBe(true);
    expect(state.total).toBe(5);
    expect(state.entries[0].state).toBe("running");
    expect(state.entries[1].state).toBe("pending");
  });

  it("stops the rest of the run when an agent fails", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    failOn = "director";
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();

    // A later plan written against a missing earlier one is not what was asked for.
    expect(runs).toEqual(["world:p1", "director:p1"]);
    const state = getCanvasQueue("p1");
    expect(state.entries.find((e) => e.agentKey === "director")?.state).toBe("failed");
    expect(state.entries.find((e) => e.agentKey === "art")?.state).toBe("cancelled");
    expect(state.active).toBe(false);
  });

  it("refuses to start a second run for the same project", async () => {
    const { enqueueCanvasRun } = await queue();
    gate = () => undefined;
    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();

    expect(() => enqueueCanvasRun("p1", { includeStoryboard: false })).toThrow(/in progress/i);
  });

  it("abandons what has not started when cancelled", async () => {
    const { enqueueCanvasRun, cancelCanvasRun, getCanvasQueue } = await queue();
    gate = () => undefined;
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();

    cancelCanvasRun("p1");
    const state = getCanvasQueue("p1");
    expect(state.entries.filter((e) => e.state === "cancelled")).toHaveLength(4);
    // The agent already in flight is not interrupted; it is mid-call on a model.
    expect(state.entries[0].state).toBe("running");
  });

  it("keeps one project's run out of another's", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();

    expect(getCanvasQueue("p2").total).toBe(0);
    expect(getCanvasQueue("p1").total).toBe(4);
  });
});

/**
 * What a browser can tell from a snapshot alone.
 *
 * The client reconciles on the set of terminal entries rather than on an
 * observed active → inactive transition, because a deterministic run is over
 * before the first poll. These pin the snapshot properties that makes that
 * deduplication safe without a persisted queue revision (SPEC-008 owns that).
 */
describe("canvas queue snapshots a client can reconcile", () => {
  it("reports a run that finished before any poll as terminal and stamped", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();

    const state = getCanvasQueue("p1");
    expect(state.active).toBe(false);
    expect(state.done).toBe(state.total);
    // `finishedAt` is what separates this terminal set from the next run's.
    expect(state.entries.every((e) => Boolean(e.finishedAt))).toBe(true);
  });

  it("makes a repeated run's terminal set distinguishable from the last one", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    const signature = (projectId: string) =>
      getCanvasQueue(projectId)
        .entries.filter((e) => e.state === "completed")
        .map((e) => `${e.agentKey}:${e.state}:${e.finishedAt}`)
        .join(",");

    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();
    const first = signature("p1");

    await new Promise((resolve) => setTimeout(resolve, 5));
    enqueueCanvasRun("p1", { includeStoryboard: false });
    await settle();
    const second = signature("p1");

    // Enqueue clears the finished entries, so the second run cannot be mistaken
    // for the first even though both end all-completed.
    expect(getCanvasQueue("p1").total).toBe(4);
    expect(second).not.toBe(first);
  });

  it("reports a cancelled run as terminal with stamped entries", async () => {
    const { enqueueCanvasRun, cancelCanvasRun, getCanvasQueue } = await queue();
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();
    // Cancel after the run is over: nothing left to abandon, still terminal.
    cancelCanvasRun("p1");

    const state = getCanvasQueue("p1");
    expect(state.active).toBe(false);
    expect(state.entries.every((e) => Boolean(e.finishedAt))).toBe(true);
  });

  it("reports a failed run as terminal with the failed agent named", async () => {
    const { enqueueCanvasRun, getCanvasQueue } = await queue();
    failOn = "cinematographer";
    enqueueCanvasRun("p1", { includeStoryboard: true });
    await settle();

    const state = getCanvasQueue("p1");
    expect(state.active).toBe(false);
    const failed = state.entries.find((e) => e.state === "failed");
    expect(failed?.agentName).toBe("Cinematographer");
    expect(failed?.error).toMatch(/exploded/);
    expect(state.entries.every((e) => Boolean(e.finishedAt))).toBe(true);
  });
});
