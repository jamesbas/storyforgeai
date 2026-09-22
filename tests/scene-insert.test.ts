import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { insertScene, previewSceneInsert } from "@/lib/services/scene-order-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { resetSceneQueue } from "@/lib/services/scene-queue";

/**
 * Adding a scene to a storyboard that already exists.
 *
 * The whole point is that it costs nothing already earned: the only way to gain
 * a scene used to be regenerating the storyboard, which mints fresh ids and so
 * discards every frame, seed and hand edit in the project.
 */

const CARD = {
  title: "The Bridge",
  visualDescription: "A wide shot of a flooded underpass at dusk.",
  actionDescription: "The courier wades through knee-deep water.",
};

async function seeded() {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 80,
  });
  return generateStoryboard(project.id);
}

describe("inserting a scene", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("places it after the anchor and renumbers the board", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    const { record: after, sceneId, sceneNumber } = await insertScene(record.project.id, {
      anchorSceneId: scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    const order = after.storyboard!.scenes;
    expect(sceneNumber).toBe(3);
    expect(order[2]!.id).toBe(sceneId);
    expect(order.map((s) => s.sceneNumber)).toEqual(order.map((_, i) => i + 1));
    expect(order).toHaveLength(scenes.length + 1);
  });

  /** Two labels for one gap: the FR-U6 guarantee, end to end. */
  it("puts 'after scene 2' and 'before scene 3' in the same place", async () => {
    const a = await seeded();
    const b = await seeded();

    const first = await insertScene(a.project.id, {
      anchorSceneId: a.storyboard!.scenes[1]!.id,
      side: "after",
      card: CARD,
    });
    const second = await insertScene(b.project.id, {
      anchorSceneId: b.storyboard!.scenes[2]!.id,
      side: "before",
      card: CARD,
    });

    expect(first.sceneNumber).toBe(second.sceneNumber);
    expect(
      first.record.storyboard!.scenes.map((s) => s.title),
    ).toEqual(second.record.storyboard!.scenes.map((s) => s.title));
  });

  it("prepends before the first scene and appends after the last", async () => {
    const front = await seeded();
    const first = await insertScene(front.project.id, {
      anchorSceneId: front.storyboard!.scenes[0]!.id,
      side: "before",
      card: CARD,
    });
    expect(first.sceneNumber).toBe(1);

    const back = await seeded();
    const last = await insertScene(back.project.id, {
      anchorSceneId: back.storyboard!.scenes.at(-1)!.id,
      side: "after",
      card: CARD,
    });
    expect(last.sceneNumber).toBe(back.storyboard!.scenes.length + 1);
  });

  it("mints an id that owes nothing to the position", async () => {
    const record = await seeded();
    const { sceneId, record: after } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[0]!.id,
      side: "after",
      card: CARD,
    });

    expect(sceneId).toContain("-scene-x-");
    expect(new Set(after.storyboard!.scenes.map((s) => s.id)).size).toBe(
      after.storyboard!.scenes.length,
    );
  });

  it("grows the piece rather than shortening the other scenes", async () => {
    const record = await seeded();
    const { project } = record;

    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    expect(after.project.segmentCount).toBe(project.segmentCount + 1);
    expect(after.project.generatedDurationSeconds).toBe(
      project.generatedDurationSeconds + project.segmentSeconds,
    );
    expect(after.project.requestedDurationSeconds).toBe(
      project.requestedDurationSeconds + project.segmentSeconds,
    );
    // The creator asked for a longer piece; the original rounding overshoot is
    // still all the trim represents.
    expect(after.project.finalTrimSeconds).toBe(project.finalTrimSeconds);
    for (const scene of after.storyboard!.scenes) {
      expect(scene.targetDurationSeconds).toBe(project.segmentSeconds);
    }
  });

  it("keeps the timeline contiguous", async () => {
    const record = await seeded();
    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    after.storyboard!.scenes.forEach((scene, index) => {
      expect(scene.startTimeSeconds).toBe(index * after.project.segmentSeconds);
      expect(scene.endTimeSeconds).toBe(scene.startTimeSeconds + after.project.segmentSeconds);
    });
  });

  it("gives the new scene a complete set of prompts with no model call", async () => {
    const record = await seeded();
    const { record: after, sceneId } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    const inserted = after.storyboard!.scenes.find((s) => s.id === sceneId)!;
    expect(inserted.prompts.startFramePrompt.length).toBeGreaterThan(0);
    expect(inserted.prompts.endFramePrompt.length).toBeGreaterThan(0);
    expect(inserted.prompts.videoPromptSegment.length).toBeGreaterThan(0);
  });

  it("carries the card the creator wrote", async () => {
    const record = await seeded();
    const { record: after, sceneId } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[0]!.id,
      side: "after",
      card: { ...CARD, transitionIn: "Cut to" },
    });

    const inserted = after.storyboard!.scenes.find((s) => s.id === sceneId)!;
    expect(inserted.title).toBe(CARD.title);
    expect(inserted.visualDescription).toBe(CARD.visualDescription);
    expect(inserted.transitionIn).toBe("Cut to");
  });

  /** No attempts, so the next batch picks it up and only it. */
  it("leaves the new scene with no media", async () => {
    const record = await seeded();
    const { record: after, sceneId } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[0]!.id,
      side: "after",
      card: CARD,
    });

    expect(after.attempts?.[sceneId]).toBeUndefined();
  });

  it("moves the end trim onto the appended scene", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 70,
    });
    const record = await generateStoryboard(project.id);
    const oldLast = record.storyboard!.scenes.at(-1)!;
    expect(oldLast.trimAtEndSeconds).toBeDefined();

    const { record: after, sceneId } = await insertScene(project.id, {
      anchorSceneId: oldLast.id,
      side: "after",
      card: CARD,
    });

    const scenes = after.storyboard!.scenes;
    expect(scenes.find((s) => s.id === oldLast.id)!.trimAtEndSeconds).toBeUndefined();
    expect(scenes.at(-1)!.id).toBe(sceneId);
    expect(scenes.at(-1)!.trimAtEndSeconds).toBeDefined();
  });

  it("records the insertion in the history", async () => {
    const record = await seeded();
    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    const entry = (after.history ?? []).at(-1);
    expect(entry?.action).toBe("scene.inserted");
    expect(entry?.detail).toContain("after scene 2");
  });

  it("persists, so the scene survives a reload", async () => {
    const record = await seeded();
    const { sceneId } = await insertScene(record.project.id, {
      anchorSceneId: record.storyboard!.scenes[0]!.id,
      side: "after",
      card: CARD,
    });

    const reloaded = await getProjectRecord(record.project.id);
    expect(reloaded.storyboard!.scenes[1]!.id).toBe(sceneId);
  });

  it("refuses an anchor that is not in the project", async () => {
    const record = await seeded();
    await expect(
      insertScene(record.project.id, { anchorSceneId: "nope", side: "after", card: CARD }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses a card with no visual or action", async () => {
    const record = await seeded();
    await expect(
      insertScene(record.project.id, {
        anchorSceneId: record.storyboard!.scenes[0]!.id,
        side: "after",
        card: { title: "Nothing", visualDescription: "", actionDescription: "" },
      }),
    ).rejects.toThrow();
  });
});

describe("what an insertion must not touch", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("keeps every id-keyed structure and every other scene's prompts", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    await updateScenePrompts(record.project.id, scenes[3]!.id, {
      endFramePrompt: "A hand-written prompt that must survive.",
    });

    const seeded2 = await getProjectRecord(record.project.id);
    const withWork = {
      ...seeded2,
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
      project: { ...seeded2.project, sceneSeeds: { [scenes[0]!.id]: 4321 } },
    } as unknown as typeof seeded2;
    const { repository } = await import("@/lib/db/store");
    await repository.update(record.project.id, withWork);

    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: scenes[0]!.id,
      side: "after",
      card: CARD,
    });

    expect(after.attempts).toEqual(withWork.attempts);
    expect(after.project.sceneSeeds).toEqual(withWork.project.sceneSeeds);
    expect(
      after.storyboard!.scenes.find((s) => s.id === scenes[3]!.id)!.prompts.endFramePrompt,
    ).toBe("A hand-written prompt that must survive.");
  });

  it("changes no existing scene id", async () => {
    const record = await seeded();
    const before = record.storyboard!.scenes.map((s) => s.id);

    const { record: after, sceneId } = await insertScene(record.project.id, {
      anchorSceneId: before[1]!,
      side: "after",
      card: CARD,
    });

    const ids = after.storyboard!.scenes.map((s) => s.id);
    expect(ids.filter((id) => id !== sceneId)).toEqual(before);
  });

  it("does not rewrite the follower unless asked", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const follower = scenes[2]!;

    await updateScenePrompts(record.project.id, follower.id, {
      startFramePrompt: "SENTINEL-OPENING",
    });

    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    expect(
      after.storyboard!.scenes.find((s) => s.id === follower.id)!.prompts.startFramePrompt,
    ).toBe("SENTINEL-OPENING");
  });

  it("rewrites the follower when asked", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const follower = scenes[2]!;

    await updateScenePrompts(record.project.id, follower.id, {
      startFramePrompt: "SENTINEL-OPENING",
    });

    const { record: after } = await insertScene(record.project.id, {
      anchorSceneId: scenes[1]!.id,
      side: "after",
      card: CARD,
      rewriteFollower: true,
    });

    expect(
      after.storyboard!.scenes.find((s) => s.id === follower.id)!.prompts.startFramePrompt,
    ).not.toBe("SENTINEL-OPENING");
  });

  it("reports a follower holding a frame from what is no longer its neighbour", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const follower = scenes[2]!;

    const withFrame = {
      ...record,
      attempts: {
        [follower.id]: [
          {
            id: "a1",
            sceneId: follower.id,
            attemptNumber: 1,
            approved: false,
            createdAt: new Date().toISOString(),
            settingsIds: [],
            startImageInherited: true,
            startImagePath: "/tmp/carried.png",
          },
        ],
      },
    } as unknown as typeof record;
    const { repository } = await import("@/lib/db/store");
    await repository.update(record.project.id, withFrame);

    const result = await insertScene(record.project.id, {
      anchorSceneId: scenes[1]!.id,
      side: "after",
      card: CARD,
    });

    expect(result.followerSceneId).toBe(follower.id);
    expect(result.followerFrameStale).toBe(true);
    // Never repaired behind the creator's back.
    expect(result.record.attempts?.[follower.id]?.[0]?.startImagePath).toBe("/tmp/carried.png");
  });
});

describe("the insertion preview", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
    resetSceneQueue();
  });

  it("describes the insertion without making it", async () => {
    const record = await seeded();
    const impact = await previewSceneInsert(
      record.project.id,
      record.storyboard!.scenes[1]!.id,
      "after",
    );

    const reloaded = await getProjectRecord(record.project.id);
    expect(impact).toHaveProperty("clean");
    expect(reloaded.storyboard!.scenes).toHaveLength(record.storyboard!.scenes.length);
  });

  /** The scene being added has nothing to invalidate; only the follower has. */
  it("never names the scene that does not exist yet", async () => {
    const record = await seeded();
    const impact = await previewSceneInsert(
      record.project.id,
      record.storyboard!.scenes[1]!.id,
      "after",
    );

    const ids = record.storyboard!.scenes.map((s) => s.id);
    for (const scene of impact.promptSeams) expect(ids).toContain(scene.id);
  });
});
