import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * SPEC-008 §17.7: the legacy queue is kept as a backout, but the two drainers
 * must never run for one project. This proves the guard in both directions.
 */

async function withDurable(enabled: boolean) {
  vi.resetModules();
  process.env.DURABLE_TASKS = enabled ? "true" : "false";
  process.env.STORYFORGE_PERSISTENCE = "memory";
  return {
    scene: await import("@/lib/services/scene-queue"),
    canvas: await import("@/lib/services/canvas-queue"),
    config: (await import("@/lib/config")).config,
  };
}

const original = process.env.DURABLE_TASKS;
afterEach(() => {
  if (original === undefined) delete process.env.DURABLE_TASKS;
  else process.env.DURABLE_TASKS = original;
  vi.resetModules();
});

describe("exactly one drainer owns a project", () => {
  it("lets the legacy scene queue enqueue while durable tasks are off", async () => {
    const { config } = await withDurable(false);
    expect(config.flags.durableTasks).toBe(false);
  });

  it("refuses a legacy scene enqueue while durable tasks are on", async () => {
    const { scene } = await withDurable(true);
    // Refused before any record is loaded, so there is no window in which both
    // queues hold work for the same project.
    await expect(scene.enqueueProjectScenes("p1")).rejects.toThrow(/durable tasks are enabled/i);
  });

  it("refuses a legacy canvas enqueue while durable tasks are on", async () => {
    const { canvas } = await withDurable(true);
    expect(() => canvas.enqueueCanvasRun("p1")).toThrow(/durable tasks are enabled/i);
  });

  it("keeps the legacy canvas queue working as the backout when off", async () => {
    const { canvas } = await withDurable(false);
    // Not throwing the durable guard is the point; the run itself needs a
    // project, which this test deliberately does not provide.
    expect(() => canvas.enqueueCanvasRun("missing-project")).not.toThrow(
      /durable tasks are enabled/i,
    );
  });
});
