import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { moveScene, previewSceneMove } from "@/lib/services/scene-order-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { resetSceneQueue } from "@/lib/services/scene-queue";

/**
 * Moving a scene through the service.
 *
 * The core transform is covered in `running-order.test.ts`; what these assert
 * is the promise the feature is sold on — that rearranging the running order
 * costs nothing that was already earned.
 */

async function seeded() {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 80,
  });
  return generateStoryboard(project.id);
}

describe("moving a scene", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("renumbers the storyboard and keeps the timeline contiguous", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const third = scenes[2]!;

    const { record: after } = await moveScene(record.project.id, third.id, { direction: "up" });
    const order = after.storyboard!.scenes;

    expect(order[1]!.id).toBe(third.id);
    expect(order.map((s) => s.sceneNumber)).toEqual(order.map((_, i) => i + 1));
    expect(order.map((s) => s.startTimeSeconds)).toEqual(
      order.map((_, i) => i * after.project.segmentSeconds),
    );
  });

  it("carries a hand-edited prompt with the scene", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const target = scenes[2]!;

    await updateScenePrompts(record.project.id, target.id, {
      endFramePrompt: "A hand-written prompt that must survive.",
    });

    const { record: after } = await moveScene(record.project.id, target.id, { direction: "up" });
    const moved = after.storyboard!.scenes.find((s) => s.id === target.id);

    expect(moved!.sceneNumber).toBe(2);
    expect(moved!.prompts.endFramePrompt).toBe("A hand-written prompt that must survive.");
  });

  it("changes no scene id", async () => {
    const record = await seeded();
    const before = record.storyboard!.scenes.map((s) => s.id);

    const { record: after } = await moveScene(record.project.id, before[1]!, { direction: "down" });

    expect(new Set(after.storyboard!.scenes.map((s) => s.id))).toEqual(new Set(before));
  });

  it("leaves the project totals alone", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[1]!;
    const { project } = record;

    const { record: after } = await moveScene(record.project.id, target.id, { direction: "down" });

    expect(after.project.segmentCount).toBe(project.segmentCount);
    expect(after.project.generatedDurationSeconds).toBe(project.generatedDurationSeconds);
    expect(after.project.requestedDurationSeconds).toBe(project.requestedDurationSeconds);
    expect(after.project.finalTrimSeconds).toBe(project.finalTrimSeconds);
  });

  it("records the move in the history", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[0]!;

    const { record: after } = await moveScene(record.project.id, target.id, { direction: "down" });

    const entry = (after.history ?? []).at(-1);
    expect(entry?.action).toBe("scene.moved");
    expect(entry?.detail).toContain("position 2");
  });

  it("refuses to move the first scene up or the last down", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    await expect(
      moveScene(record.project.id, scenes[0]!.id, { direction: "up" }),
    ).rejects.toThrow(/already first/);
    await expect(
      moveScene(record.project.id, scenes.at(-1)!.id, { direction: "down" }),
    ).rejects.toThrow(/already last/);
  });

  it("refuses a scene that is not in the project", async () => {
    const record = await seeded();
    await expect(moveScene(record.project.id, "nope", { direction: "up" })).rejects.toThrow(
      /not found/,
    );
  });

  it("persists, so the move survives a reload", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[2]!;

    await moveScene(record.project.id, target.id, { direction: "up" });
    const reloaded = await getProjectRecord(record.project.id);

    expect(reloaded.storyboard!.scenes[1]!.id).toBe(target.id);
  });
});

/**
 * The guarantee the whole feature rests on. Everything expensive is keyed by
 * scene id, so a reorder must leave all of it exactly as it found it.
 */
describe("what a move must not touch", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("leaves every id-keyed structure identical", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    const withWork = {
      ...record,
      attempts: {
        [scenes[0]!.id]: [
          {
            id: "a1",
            sceneId: scenes[0]!.id,
            attemptNumber: 1,
            approved: false,
            createdAt: new Date().toISOString(),
            settingsIds: [],
          },
        ],
      },
      previews: { [scenes[1]!.id]: { startImagePath: "/tmp/p.png" } },
      project: {
        ...record.project,
        sceneSeeds: { [scenes[0]!.id]: 1234, [scenes[2]!.id]: 5678 },
        sceneEndFrameRefs: { [scenes[1]!.id]: true },
      },
    } as unknown as typeof record;

    const { repository } = await import("@/lib/db/store");
    await repository.update(record.project.id, withWork);

    const { record: after } = await moveScene(record.project.id, scenes[2]!.id, {
      direction: "up",
    });

    expect(after.attempts).toEqual(withWork.attempts);
    expect(after.previews).toEqual(withWork.previews);
    expect(after.project.sceneSeeds).toEqual(withWork.project.sceneSeeds);
    expect(after.project.sceneEndFrameRefs).toEqual(withWork.project.sceneEndFrameRefs);
  });

  it("does not rewrite any prompt unless asked", async () => {
    const record = await seeded();
    const before = Object.fromEntries(
      record.storyboard!.scenes.map((s) => [s.id, s.prompts] as const),
    );

    const { record: after, rewrittenScenes } = await moveScene(
      record.project.id,
      record.storyboard!.scenes[2]!.id,
      { direction: "up" },
    );

    expect(rewrittenScenes).toEqual([]);
    for (const scene of after.storyboard!.scenes) {
      expect(scene.prompts).toEqual(before[scene.id]);
    }
  });
});

/**
 * The opt-in repair (FR-21).
 *
 * Offered because a move genuinely invalidates the openings it disturbs, and
 * opt-in because those openings may have been written by hand.
 */
describe("rewriting the prompts a move invalidated", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("rewrites exactly the scenes the impact named", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[2]!;

    const { impact, rewrittenScenes } = await moveScene(record.project.id, target.id, {
      direction: "up",
      rewritePrompts: true,
    });

    expect(impact.promptSeams.length).toBeGreaterThan(0);
    expect(rewrittenScenes).toEqual(impact.promptSeams.map((s) => s.id));
  });

  /** Proof the rewrite actually ran: a sentinel hand edit is replaced. */
  it("replaces a hand-edited opening on an affected scene", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const affected = scenes[3]!;

    await updateScenePrompts(record.project.id, affected.id, {
      startFramePrompt: "SENTINEL-OPENING",
    });

    const { record: after, rewrittenScenes } = await moveScene(
      record.project.id,
      scenes[2]!.id,
      { direction: "up", rewritePrompts: true },
    );

    expect(rewrittenScenes).toContain(affected.id);
    const moved = after.storyboard!.scenes.find((s) => s.id === affected.id);
    expect(moved!.prompts.startFramePrompt).not.toBe("SENTINEL-OPENING");
  });

  /** Only the keyframe seam was invalidated, so only the image pass runs. */
  it("leaves the clip prompts alone", async () => {
    const record = await seeded();
    const before = Object.fromEntries(
      record.storyboard!.scenes.map((s) => [s.id, s.prompts.videoPromptSegment] as const),
    );

    const { record: after } = await moveScene(record.project.id, record.storyboard!.scenes[2]!.id, {
      direction: "up",
      rewritePrompts: true,
    });

    for (const scene of after.storyboard!.scenes) {
      expect(scene.prompts.videoPromptSegment).toBe(before[scene.id]);
    }
  });

  it("does nothing when the move invalidated no opening", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 80,
      sceneContinuity: "cut",
    });
    const record = await generateStoryboard(project.id);

    const { impact, rewrittenScenes } = await moveScene(
      project.id,
      record.storyboard!.scenes[2]!.id,
      { direction: "up", rewritePrompts: true },
    );

    expect(impact.promptSeams).toEqual([]);
    expect(rewrittenScenes).toEqual([]);
  });
});

describe("the impact preview", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("describes the move without making it", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[2]!;

    const impact = await previewSceneMove(record.project.id, target.id, "up");
    const reloaded = await getProjectRecord(record.project.id);

    expect(impact).toHaveProperty("clean");
    expect(reloaded.storyboard!.scenes.map((s) => s.id)).toEqual(
      record.storyboard!.scenes.map((s) => s.id),
    );
  });

  it("refuses a move that cannot be made", async () => {
    const record = await seeded();
    await expect(
      previewSceneMove(record.project.id, record.storyboard!.scenes[0]!.id, "up"),
    ).rejects.toThrow(/already first/);
  });
});
