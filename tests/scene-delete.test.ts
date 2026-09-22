import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { deleteScene, previewSceneDelete } from "@/lib/services/scene-order-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { resetSceneQueue } from "@/lib/services/scene-queue";

/**
 * Removing a scene.
 *
 * The only one of the three running-order operations that destroys anything,
 * so these are as much about what it declines to do — leaving the rendered
 * files on disk, never emptying a storyboard — as about what it removes.
 */

async function seeded() {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 80,
  });
  return generateStoryboard(project.id);
}

describe("deleting a scene", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("removes it and renumbers what is left", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const target = scenes[1]!;

    const { record: after } = await deleteScene(record.project.id, target.id);
    const order = after.storyboard!.scenes;

    expect(order.map((s) => s.id)).not.toContain(target.id);
    expect(order).toHaveLength(scenes.length - 1);
    expect(order.map((s) => s.sceneNumber)).toEqual(order.map((_, i) => i + 1));
  });

  it("keeps the timeline contiguous", async () => {
    const record = await seeded();
    const { record: after } = await deleteScene(record.project.id, record.storyboard!.scenes[1]!.id);

    after.storyboard!.scenes.forEach((scene, index) => {
      expect(scene.startTimeSeconds).toBe(index * after.project.segmentSeconds);
    });
  });

  it("shortens the piece by one segment", async () => {
    const record = await seeded();
    const { project } = record;

    const { record: after } = await deleteScene(record.project.id, record.storyboard!.scenes[1]!.id);

    expect(after.project.segmentCount).toBe(project.segmentCount - 1);
    expect(after.project.generatedDurationSeconds).toBe(
      project.generatedDurationSeconds - project.segmentSeconds,
    );
    expect(after.project.requestedDurationSeconds).toBe(
      project.requestedDurationSeconds - project.segmentSeconds,
    );
  });

  it("moves the end trim off a deleted final scene", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 70,
    });
    const record = await generateStoryboard(project.id);
    const scenes = record.storyboard!.scenes;
    expect(scenes.at(-1)!.trimAtEndSeconds).toBeDefined();

    const { record: after } = await deleteScene(project.id, scenes.at(-1)!.id);

    expect(after.storyboard!.scenes.at(-1)!.id).toBe(scenes.at(-2)!.id);
    expect(after.storyboard!.scenes.at(-1)!.trimAtEndSeconds).toBeDefined();
  });

  it("carries every other scene's hand edits through untouched", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    await updateScenePrompts(record.project.id, scenes[3]!.id, {
      endFramePrompt: "A hand-written prompt that must survive.",
    });

    const { record: after } = await deleteScene(record.project.id, scenes[1]!.id);

    expect(
      after.storyboard!.scenes.find((s) => s.id === scenes[3]!.id)!.prompts.endFramePrompt,
    ).toBe("A hand-written prompt that must survive.");
  });

  it("records the deletion in the history", async () => {
    const record = await seeded();
    const { record: after } = await deleteScene(record.project.id, record.storyboard!.scenes[1]!.id);

    const entry = (after.history ?? []).at(-1);
    expect(entry?.action).toBe("scene.deleted");
    expect(entry?.detail).toContain("Scene 2");
  });

  it("persists", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[1]!;

    await deleteScene(record.project.id, target.id);
    const reloaded = await getProjectRecord(record.project.id);

    expect(reloaded.storyboard!.scenes.map((s) => s.id)).not.toContain(target.id);
  });

  /** A storyboard with no scenes is not a storyboard. */
  it("refuses to empty the storyboard", async () => {
    const project = await createProject({
      concept: "A single shot.",
      requestedDurationSeconds: 20,
    });
    const record = await generateStoryboard(project.id);
    expect(record.storyboard!.scenes).toHaveLength(1);

    await expect(deleteScene(project.id, record.storyboard!.scenes[0]!.id)).rejects.toThrow(
      /at least one scene/,
    );
  });

  it("refuses a scene that is not in the project", async () => {
    const record = await seeded();
    await expect(deleteScene(record.project.id, "nope")).rejects.toThrow(/not found/);
  });
});

describe("what a deletion takes with it", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  async function withWork() {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const doomed = scenes[1]!;
    const kept = scenes[2]!;

    const attempt = (sceneId: string) => ({
      id: `a-${sceneId}`,
      sceneId,
      attemptNumber: 1,
      approved: false,
      createdAt: new Date().toISOString(),
      settingsIds: [],
    });

    const seededRecord = {
      ...record,
      attempts: { [doomed.id]: [attempt(doomed.id)], [kept.id]: [attempt(kept.id)] },
      previews: { [doomed.id]: { startImagePath: "/tmp/doomed.png" } },
      executions: [
        { artifact: `${doomed.id}.image_prompt`, at: "2026-01-01T00:00:00Z", source: "model" },
        { artifact: `${kept.id}.image_prompt`, at: "2026-01-01T00:00:00Z", source: "model" },
      ],
      audioPlan: {
        projectId: record.project.id,
        cues: [
          { id: "c1", sceneId: doomed.id, kind: "sfx", prompt: "splash", startSeconds: 2 },
          { id: "c2", sceneId: kept.id, kind: "sfx", prompt: "rain", startSeconds: 1 },
        ],
      },
      project: {
        ...record.project,
        sceneSeeds: { [doomed.id]: 111, [kept.id]: 222 },
        sceneEndFrameRefs: { [doomed.id]: true, [kept.id]: true },
        wardrobeChanges: {
          [doomed.id]: [{ characterId: "c1", wardrobe: "a red coat", mode: "between" }],
        },
      },
    } as unknown as typeof record;

    const { repository } = await import("@/lib/db/store");
    await repository.update(record.project.id, seededRecord);
    return { projectId: record.project.id, doomed, kept };
  }

  it("removes everything the scene owned, and nothing anyone else's", async () => {
    const { projectId, doomed, kept } = await withWork();

    const { record: after } = await deleteScene(projectId, doomed.id);

    expect(after.attempts?.[doomed.id]).toBeUndefined();
    expect(after.previews?.[doomed.id]).toBeUndefined();
    expect(after.project.sceneSeeds?.[doomed.id]).toBeUndefined();
    expect(after.project.sceneEndFrameRefs?.[doomed.id]).toBeUndefined();
    expect(after.project.wardrobeChanges?.[doomed.id]).toBeUndefined();
    expect(after.executions?.some((e) => e.artifact.startsWith(`${doomed.id}.`))).toBe(false);

    expect(after.attempts?.[kept.id]).toBeDefined();
    expect(after.project.sceneSeeds?.[kept.id]).toBe(222);
    expect(after.executions?.some((e) => e.artifact.startsWith(`${kept.id}.`))).toBe(true);
  });

  /**
   * A cue anchors to its scene for its duration, so one left behind throws
   * `NotFoundError` the next time anybody opens it.
   */
  it("takes the scene's audio cues, and leaves the others", async () => {
    const { projectId, doomed, kept } = await withWork();

    const { record: after, removedCues } = await deleteScene(projectId, doomed.id);

    expect(removedCues).toBe(1);
    expect(after.audioPlan!.cues.map((c) => c.sceneId)).toEqual([kept.id]);
  });

  it("reports that the scene had media, whose files are left on disk", async () => {
    const { projectId, doomed } = await withWork();
    const { hadMedia } = await deleteScene(projectId, doomed.id);
    expect(hadMedia).toBe(true);
  });

  it("drops the departed scene's plan entry rather than leaving it on a number", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    const withPlans = {
      ...record,
      directorialPlan: {
        projectId: record.project.id,
        sceneIntent: { "1": "open", "2": "the doomed one", "3": "carry on", "4": "close" },
      },
    } as unknown as typeof record;
    const { repository } = await import("@/lib/db/store");
    await repository.update(record.project.id, withPlans);

    const { record: after } = await deleteScene(record.project.id, scenes[1]!.id);

    expect(after.directorialPlan!.sceneIntent).toEqual({
      "1": "open",
      "2": "carry on",
      "3": "close",
    });
  });
});

describe("the deletion preview", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("describes the deletion without making it", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[1]!;

    const preview = await previewSceneDelete(record.project.id, target.id);
    const reloaded = await getProjectRecord(record.project.id);

    expect(preview).toHaveProperty("impact");
    expect(preview.hadMedia).toBe(false);
    expect(reloaded.storyboard!.scenes).toHaveLength(record.storyboard!.scenes.length);
  });
});
