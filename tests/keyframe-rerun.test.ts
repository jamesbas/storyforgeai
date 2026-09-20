import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
} from "@/lib/services/project-service";
import {
  enqueueKeyframeRerun,
  enqueueProjectScenes,
  getQueue,
  keyframeRerunFollowOn,
  resetSceneQueue,
  waitForQueue,
} from "@/lib/services/scene-queue";
import { regenerateSceneKeyframes } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Re-rendering keyframes without paying for the clips between them.
 *
 * The mirror of the clip-only rerun. An image prompt, a seed or an image LoRA
 * moves the frames and nothing else, and a full regeneration then spends the
 * longest job of the scene rendering a clip from frames nobody has looked at
 * yet — and the only alternative was visiting each card in turn.
 */

async function seeded(generationMode = "video_segments"): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 60,
    ...(generationMode === "video_segments" ? {} : { generationMode }),
  } as Parameters<typeof createProject>[0]);
  return generateStoryboard(project.id);
}

describe("rebuilding one scene's keyframes", () => {
  beforeEach(() => {
    resetSceneQueue();
    setWangpClient(new MockWangpClient());
  });

  it("renders fresh frames and no clip", async () => {
    const record = await seeded();
    const sceneId = record.storyboard!.scenes[0]!.id;
    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    const before = (await getProjectRecord(record.project.id)).attempts![sceneId]!.at(-1)!;
    expect(before.videoPath).toBeTruthy();

    const after = await regenerateSceneKeyframes(record.project.id, sceneId);
    const latest = after.attempts![sceneId]!.at(-1)!;

    expect(after.attempts![sceneId]!.length).toBe(before.attemptNumber + 1);
    expect(latest.startImagePath).toBeTruthy();
    expect(latest.startImagePath).not.toBe(before.startImagePath);
    // The point of the whole feature: no video model is loaded.
    expect(latest.videoPath).toBeUndefined();
  });

  /**
   * Carrying the old clip forward would claim a video built from frames that
   * no longer exist. An empty one is the state "Generate all media" already
   * finishes for the price of the clip alone.
   */
  it("leaves the attempt in the state a clip-only batch picks up", async () => {
    const record = await seeded();
    const sceneId = record.storyboard!.scenes[0]!.id;
    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    await regenerateSceneKeyframes(record.project.id, sceneId);

    resetSceneQueue();
    const queued = await enqueueProjectScenes(record.project.id);
    expect(queued.map((entry) => entry.sceneId)).toEqual([sceneId]);
    expect(queued[0]!.scope).toBe("video");
    await waitForQueue();
  });

  it("leaves every other scene exactly as it was", async () => {
    const record = await seeded();
    const [first, second] = record.storyboard!.scenes;
    await enqueueProjectScenes(record.project.id);
    await waitForQueue();

    const untouched = (await getProjectRecord(record.project.id)).attempts![second!.id]!;
    await regenerateSceneKeyframes(record.project.id, first!.id);

    const after = await getProjectRecord(record.project.id);
    expect(after.attempts![second!.id]).toEqual(untouched);
  });
});

describe("queueing a keyframes-only rerun", () => {
  beforeEach(() => {
    resetSceneQueue();
    setWangpClient(new MockWangpClient());
  });

  it("queues only the scenes picked, scoped to keyframes", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    const { entries } = await enqueueKeyframeRerun(record.project.id, [
      scenes[0]!.id,
      scenes[2]!.id,
    ]);

    expect(entries.map((e) => e.sceneId)).toEqual([scenes[0]!.id, scenes[2]!.id]);
    expect(entries.every((e) => e.scope === "keyframes")).toBe(true);
    await waitForQueue();

    const after = await getProjectRecord(record.project.id);
    expect(after.attempts![scenes[0]!.id]).toHaveLength(1);
    expect(after.attempts![scenes[1]!.id]).toBeUndefined();
  });

  /** Empty means every scene, matching the clip queue and the prompt rewrite. */
  it("treats an empty selection as the whole project", async () => {
    const record = await seeded();
    const { entries } = await enqueueKeyframeRerun(record.project.id, []);
    expect(entries).toHaveLength(record.storyboard!.scenes.length);
    await waitForQueue();

    expect(getQueue(record.project.id).entries.every((e) => e.state === "completed")).toBe(true);
  });

  it("runs the frames without ever reaching the video model", async () => {
    const record = await seeded();
    await enqueueKeyframeRerun(record.project.id);
    await waitForQueue();

    const after = await getProjectRecord(record.project.id);
    for (const scene of after.storyboard!.scenes) {
      const latest = after.attempts![scene.id]!.at(-1)!;
      expect(latest.endImagePath).toBeTruthy();
      expect(latest.videoPath).toBeUndefined();
    }
  });

  it("refuses the whole batch when one scene does not exist", async () => {
    const record = await seeded();
    await expect(
      enqueueKeyframeRerun(record.project.id, [record.storyboard!.scenes[0]!.id, "no-such-scene"]),
    ).rejects.toThrow();
    expect(getQueue(record.project.id).entries).toHaveLength(0);
  });

  it("refuses in a storyboard-only project, where nothing is rendered", async () => {
    const record = await seeded("storyboard_only");
    await expect(enqueueKeyframeRerun(record.project.id)).rejects.toThrow(/Storyboard only/i);
  });
});

/**
 * Under `reuse_end_frame` a scene's start frame is a copy of the previous
 * scene's end frame, taken when it was rendered. Re-rendering scene 1 leaves
 * scene 2 showing a picture of a frame that exists nowhere, and scene 2 still
 * looks finished — so it has to be said out loud.
 */
describe("scenes left holding an orphaned start frame", () => {
  const record = (overrides: Partial<ProjectRecord["project"]> = {}) =>
    ({
      project: { id: "p1", sceneContinuity: "reuse_end_frame", ...overrides },
      storyboard: { scenes: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, sceneNumber: n })) },
      attempts: Object.fromEntries(
        [1, 2, 3, 4].map((n) => [`s${n}`, [{ startImageInherited: n > 1 }]]),
      ),
    }) as unknown as ProjectRecord;

  it("names the scene after the one being re-rendered", () => {
    expect(keyframeRerunFollowOn(record(), ["s2"])).toEqual([3]);
  });

  it("says nothing about a successor that is in the selection already", () => {
    expect(keyframeRerunFollowOn(record(), ["s2", "s3"])).toEqual([4]);
  });

  it("says nothing when the whole project was picked", () => {
    expect(keyframeRerunFollowOn(record(), ["s1", "s2", "s3", "s4"])).toEqual([]);
  });

  it("says nothing on a cut, where no frame is carried across a seam", () => {
    expect(keyframeRerunFollowOn(record({ sceneContinuity: "cut" }), ["s2"])).toEqual([]);
  });

  /** Clips are chained there, and a keyframe rerun does not touch those. */
  it("says nothing when the chain is made of clips", () => {
    expect(keyframeRerunFollowOn(record({ sceneContinuity: "continue_video" }), ["s2"])).toEqual([]);
  });

  it("ignores a successor whose start frame was never inherited", () => {
    const base = record();
    const standalone = {
      ...base,
      attempts: { ...base.attempts, s3: [{ startImageInherited: false }] },
    } as unknown as ProjectRecord;
    expect(keyframeRerunFollowOn(standalone, ["s2"])).toEqual([]);
  });
});
