import { describe, it, expect, beforeEach } from "vitest";
import { createProject, generateStoryboard, updateProjectModels } from "@/lib/services/project-service";
import { generateSceneMedia, generateSceneKeyframe } from "@/lib/services/media-service";
import { assembleRoughCut } from "@/lib/services/assembly-service";
import { enqueueProjectScenes, getQueue, resetSceneQueue, waitForQueue } from "@/lib/services/scene-queue";
import { generationStages } from "@/lib/types";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { GenerationMode } from "@/lib/types";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Generation mode.
 *
 * The mode used to be stored and never read, so every option produced the same
 * behaviour and the Help page described four things that did not happen. These
 * tests pin the observable difference between them.
 */

async function project(mode: GenerationMode): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 40,
    generationMode: mode,
  });
  return generateStoryboard(created.id);
}

const firstSceneId = (record: ProjectRecord) => record.storyboard!.scenes[0]!.id;

beforeEach(() => {
  setWangpClient(new MockWangpClient());
  resetSceneQueue();
});

describe("what each mode permits", () => {
  it("renders nothing at all in storyboard_only", () => {
    const stages = generationStages("storyboard_only");
    expect(stages).toMatchObject({ keyframes: false, video: false, assembly: false });
  });

  /** Assembly rides with video: refusing it would strand a finished project. */
  it("allows assembly wherever clips are rendered", () => {
    expect(generationStages("video_segments").assembly).toBe(true);
    expect(generationStages("full_auto").assembly).toBe(true);
    expect(generationStages("keyframes_only").assembly).toBe(false);
  });

  it("only starts by itself in full_auto", () => {
    expect(generationStages("video_segments").autoStart).toBe(false);
    expect(generationStages("full_auto").autoStart).toBe(true);
  });
});

describe("storyboard_only", () => {
  it("refuses scene generation", async () => {
    const record = await project("storyboard_only");
    await expect(generateSceneMedia(record.project.id, firstSceneId(record))).rejects.toThrow(
      /storyboard only/i,
    );
  });

  it("refuses a keyframe preview", async () => {
    const record = await project("storyboard_only");
    await expect(
      generateSceneKeyframe(record.project.id, firstSceneId(record), "start_frame"),
    ).rejects.toThrow(/storyboard only/i);
  });

  it("refuses to queue a batch", async () => {
    const record = await project("storyboard_only");
    await expect(enqueueProjectScenes(record.project.id)).rejects.toThrow(/storyboard only/i);
  });
});

describe("keyframes_only", () => {
  /** The point of the mode: the video model is never loaded. */
  it("stores the frames and no clip", async () => {
    const record = await project("keyframes_only");
    const generated = await generateSceneMedia(record.project.id, firstSceneId(record));

    const attempt = generated.attempts?.[firstSceneId(record)]?.[0];
    expect(attempt?.startImagePath).toBeTruthy();
    expect(attempt?.endImagePath).toBeTruthy();
    expect(attempt?.videoPath).toBeUndefined();
  });

  /** QC must not fail a scene for missing media the mode never asked for. */
  it("passes QC without a clip", async () => {
    const record = await project("keyframes_only");
    const generated = await generateSceneMedia(record.project.id, firstSceneId(record));

    expect(generated.attempts?.[firstSceneId(record)]?.[0]?.qcResult?.passed).toBe(true);
  });

  it("refuses assembly", async () => {
    const record = await project("keyframes_only");
    await expect(assembleRoughCut(record.project.id)).rejects.toThrow(/does not include assembly/i);
  });
});

describe("full_auto", () => {
  it("queues every scene as soon as the storyboard exists", async () => {
    const record = await project("full_auto");

    expect(getQueue(record.project.id).entries).toHaveLength(record.storyboard!.scenes.length);
    await waitForQueue();
  });

  it("does not queue anything in the other modes", async () => {
    const record = await project("video_segments");
    expect(getQueue(record.project.id).entries).toEqual([]);
  });
});

describe("changing the mode later", () => {
  it("unblocks a project that was planned only", async () => {
    const record = await project("storyboard_only");
    const opened = await updateProjectModels(record.project.id, {
      generationMode: "video_segments",
    });

    expect(opened.project.generationMode).toBe("video_segments");
    const generated = await generateSceneMedia(opened.project.id, firstSceneId(opened));
    expect(generated.attempts?.[firstSceneId(opened)]?.[0]?.videoPath).toBeTruthy();
  });
});
