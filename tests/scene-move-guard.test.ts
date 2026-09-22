import { describe, it, expect, beforeEach, vi } from "vitest";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";

/**
 * Reordering while a batch is running.
 *
 * The queue holds scene numbers for work it has already planned, so renumbering
 * underneath it would leave entries naming a scene that has moved. Refused
 * rather than reconciled: a batch is minutes of GPU time and the creator can
 * simply move the scene when it finishes.
 *
 * The queue is mocked because making a real one reliably *stay* active for the
 * length of an assertion is a race, and what is under test is the guard.
 */
vi.mock("@/lib/services/scene-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scene-queue")>();
  return {
    ...actual,
    getQueue: () => ({ entries: [], active: true, counts: { pending: 1 } }),
  };
});

describe("moving a scene while the queue is running", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("is refused, and says why", async () => {
    const { moveScene } = await import("@/lib/services/scene-order-service");
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 80,
    });
    const record = await generateStoryboard(project.id);
    const target = record.storyboard!.scenes[1]!;

    await expect(moveScene(project.id, target.id, { direction: "up" })).rejects.toThrow(
      /queue is running/,
    );
  });

  /** A 409: the request is fine, the project is simply busy. */
  it("reports it as a prerequisite rather than bad input", async () => {
    const { moveScene } = await import("@/lib/services/scene-order-service");
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 80,
    });
    const record = await generateStoryboard(project.id);
    const target = record.storyboard!.scenes[1]!;

    await expect(
      moveScene(project.id, target.id, { direction: "up" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
