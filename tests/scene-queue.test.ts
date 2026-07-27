import { describe, it, expect, beforeEach } from "vitest";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import {
  enqueueProjectScenes,
  getQueue,
  cancelQueue,
  resetSceneQueue,
  waitForQueue,
} from "@/lib/services/scene-queue";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Batch scene generation.
 *
 * The ordering guarantee is the part worth protecting: `reuse_end_frame` and
 * `continue_video` read the previous scene's finished attempt, so anything that
 * let scenes overlap would silently degrade them back to plain cuts.
 */

async function seed(): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 60,
  });
  return generateStoryboard(project.id);
}

describe("scene generation queue", () => {
  beforeEach(() => {
    resetSceneQueue();
    setWangpClient(new MockWangpClient());
  });

  it("queues every scene and generates them all", async () => {
    const record = await seed();
    const queued = await enqueueProjectScenes(record.project.id);
    expect(queued).toHaveLength(record.storyboard!.scenes.length);

    await waitForQueue();

    const { entries, active } = getQueue(record.project.id);
    expect(active).toBe(false);
    expect(entries.every((e) => e.state === "completed")).toBe(true);
  });

  it("generates strictly in scene order so continuity can read the previous scene", async () => {
    const record = await seed();
    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    const finished = getQueue(record.project.id)
      .entries.filter((e) => e.finishedAt)
      .sort((a, b) => (a.finishedAt! < b.finishedAt! ? -1 : 1));
    expect(finished.map((e) => e.sceneNumber)).toEqual([...finished].map((e) => e.sceneNumber).sort((a, b) => a - b));

    // No scene may start before its predecessor has finished.
    const bySceneNumber = getQueue(record.project.id).entries;
    for (let i = 1; i < bySceneNumber.length; i += 1) {
      expect(bySceneNumber[i]!.startedAt! >= bySceneNumber[i - 1]!.finishedAt!).toBe(true);
    }
  });

  it("skips scenes that already have media, and regenerates them on request", async () => {
    const record = await seed();
    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    // Every scene now has an attempt, so a plain run queues nothing.
    expect(await enqueueProjectScenes(record.project.id)).toHaveLength(0);
    expect(await enqueueProjectScenes(record.project.id, { includeGenerated: true })).toHaveLength(
      record.storyboard!.scenes.length,
    );
    await waitForQueue();
  });

  it("cancels the scenes that have not started", async () => {
    const record = await seed();
    await enqueueProjectScenes(record.project.id);
    cancelQueue(record.project.id);
    await waitForQueue();

    const states = getQueue(record.project.id).entries.map((e) => e.state);
    expect(states).toContain("cancelled");
    expect(states).not.toContain("pending");
  });

  it("refuses to queue a project with no storyboard", async () => {
    const project = await createProject({
      concept: "No storyboard yet.",
      requestedDurationSeconds: 20,
    });
    await expect(enqueueProjectScenes(project.id)).rejects.toThrow(/storyboard/i);
  });

  it("retries a transient GPU fault and recovers", async () => {
    // "CUDA error: resource already mapped" is memory pressure while WanGP
    // swaps models, not a bad request — the same scene succeeds on a retry.
    // Losing an hour of queued work to one blip is the worse outcome.
    const record = await seed();
    let failures = 0;
    class FlakyGpuClient extends MockWangpClient {
      override async generate(settings: Record<string, unknown>) {
        if (failures < 1) {
          failures += 1;
          throw new Error("CUDA error: resource already mapped");
        }
        return super.generate(settings);
      }
    }
    setWangpClient(new FlakyGpuClient());

    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    const entries = getQueue(record.project.id).entries;
    expect(entries.every((e) => e.state === "completed")).toBe(true);
    expect(entries[0]!.attempts).toBe(2);
  });

  it("fails fast on an error that a retry cannot fix", async () => {
    const record = await seed();
    class BadRequestClient extends MockWangpClient {
      override async generate(_settings: Record<string, unknown>): Promise<never> {
        throw new Error("Reference image is not a supported format");
      }
    }
    setWangpClient(new BadRequestClient());

    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    const first = getQueue(record.project.id).entries[0]!;
    expect(first.state).toBe("failed");
    // No point burning a retry on something deterministic.
    expect(first.attempts).toBe(1);
  });
});
