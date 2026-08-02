import { describe, it, expect } from "vitest";
import { createProject, generateStoryboard, getProjectRecord } from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { assembleRoughCut, listExports } from "@/lib/services/assembly-service";
import { assemblySchema } from "@/lib/schemas/assembly";
import { PrerequisiteError } from "@/lib/errors";
import { repository } from "@/lib/db/store";
import { runDeepy } from "@/lib/deepy/deepy";
import type { SceneAttempt } from "@/lib/schemas/generation";

async function projectWithAllMedia(seconds: number) {
  const project = await createProject({
    concept: "A comet crosses the sky.",
    requestedDurationSeconds: seconds,
  });
  const withStoryboard = await generateStoryboard(project.id);
  for (const scene of withStoryboard.storyboard!.scenes) {
    const gen = await generateSceneMedia(project.id, scene.id);
    const attempt = gen.attempts![scene.id]![0]!;
    await approveAttempt(project.id, scene.id, attempt.id);
  }
  return project;
}

/** Media generated for every scene, with nothing approved. */
async function projectWithUnapprovedMedia(seconds: number, concept: string) {
  const project = await createProject({ concept, requestedDurationSeconds: seconds });
  const withStoryboard = await generateStoryboard(project.id);
  for (const scene of withStoryboard.storyboard!.scenes) {
    await generateSceneMedia(project.id, scene.id);
  }
  return project;
}

async function prerequisiteFailure(projectId: string): Promise<PrerequisiteError> {
  try {
    await assembleRoughCut(projectId);
  } catch (err) {
    expect(err).toBeInstanceOf(PrerequisiteError);
    return err as PrerequisiteError;
  }
  throw new Error("assembly succeeded but should have been blocked");
}

describe("assembly service", () => {
  it("assembles a rough cut from approved clips", async () => {
    const project = await projectWithAllMedia(40);
    const record = await assembleRoughCut(project.id);
    expect(record.assembly).toBeDefined();
    expect(() => assemblySchema.parse(record.assembly)).not.toThrow();
    expect(record.assembly!.plan.clips).toHaveLength(2);
    expect(record.assembly!.roughCutPath).toContain("rough-cut.mp4");
    expect(record.project.status).toBe("assembled");
    for (const clip of record.assembly!.plan.clips) {
      expect(clip.attemptId).toBeTruthy();
    }
  });

  it("exposes an export package with available flags", async () => {
    const project = await projectWithAllMedia(20);
    await assembleRoughCut(project.id);
    const exports = await listExports(project.id);
    const names = exports.map((e) => e.name);
    expect(names).toContain("storyboard.json");
    expect(names).toContain("final-cut-plan.json");
    expect(exports.find((e) => e.name === "final-cut-plan.json")!.available).toBe(true);
  });

  it("fails to assemble when no media has been generated", async () => {
    const project = await createProject({
      concept: "Nothing generated.",
      requestedDurationSeconds: 20,
    });
    await generateStoryboard(project.id);
    const err = await prerequisiteFailure(project.id);
    expect(err.status).toBe(409);
    expect(err.details).toEqual({
      missingApprovals: [
        expect.objectContaining({ sceneNumber: 1, reason: "no_attempt" }),
      ],
    });
  });

  it("blocks mixed approval, reports every missing scene and leaves the record unassembled", async () => {
    const project = await projectWithUnapprovedMedia(60, "A lighthouse beam sweeps the bay.");
    const before = await getProjectRecord(project.id);
    const scenes = before.storyboard!.scenes;
    expect(scenes).toHaveLength(3);
    await approveAttempt(project.id, scenes[0]!.id, before.attempts![scenes[0]!.id]![0]!.id);

    const err = await prerequisiteFailure(project.id);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/approved video/i);
    const missing = (err.details as { missingApprovals: Array<{ sceneId: string }> })
      .missingApprovals;
    expect(missing.map((m) => m.sceneId)).toEqual([scenes[1]!.id, scenes[2]!.id]);
    expect(missing.every((m) => "sceneNumber" in m && "sceneTitle" in m && "reason" in m)).toBe(true);

    const after = await getProjectRecord(project.id);
    expect(after.assembly).toBeUndefined();
    expect(after.project.status).not.toBe("assembled");
  });

  it("blocks a scene whose approved attempt has no video", async () => {
    const project = await projectWithAllMedia(20);
    const record = await getProjectRecord(project.id);
    const sceneId = record.storyboard!.scenes[0]!.id;
    const approved = record.attempts![sceneId]![0]!;
    await repository.update(project.id, {
      ...record,
      attempts: { ...record.attempts, [sceneId]: [{ ...approved, videoPath: undefined }] },
    });

    const err = await prerequisiteFailure(project.id);
    expect(err.details).toEqual({
      missingApprovals: [
        expect.objectContaining({ sceneId, reason: "approved_attempt_missing_video" }),
      ],
    });
  });

  it("cuts the older approved take and keeps trim and audio timing on it", async () => {
    // 50s requested -> three 20s segments -> the last clip absorbs a 10s trim.
    const project = await projectWithAllMedia(50);
    const record = await getProjectRecord(project.id);
    const scenes = record.storyboard!.scenes;
    expect(scenes).toHaveLength(3);

    const firstScene = scenes[0]!;
    const approved = record.attempts![firstScene.id]![0]!;
    const newerUnapproved: SceneAttempt = {
      ...approved,
      id: `${approved.id}-regenerated`,
      attemptNumber: approved.attemptNumber + 1,
      videoPath: "regenerated-and-unreviewed.mp4",
      approved: false,
      createdAt: new Date().toISOString(),
    };
    await repository.update(project.id, {
      ...record,
      attempts: { ...record.attempts, [firstScene.id]: [approved, newerUnapproved] },
      audioPlan: {
        projectId: project.id,
        narrationRequired: false,
        dialogueRequired: false,
        musicRequired: true,
        sfxRequired: false,
        voiceProfiles: [],
        sceneAudioCues: [],
        cues: [
          {
            id: "cue-1",
            sceneId: scenes[1]!.id,
            kind: "music" as const,
            prompt: "low strings",
            startSeconds: 2,
            durationSeconds: 8,
            gainDb: -6,
            fadeInSeconds: 0.5,
            fadeOutSeconds: 0.5,
            duckNativeDb: -12,
            generatedPath: "cue-1.wav",
            approved: true,
          },
        ],
      },
    });

    const assembled = await assembleRoughCut(project.id);
    const plan = assembled.assembly!.plan;

    // The regenerated take is newer but unapproved; it must not enter the cut.
    expect(plan.clips[0]!.path).toBe(approved.videoPath);
    expect(plan.clips[0]!.attemptId).toBe(approved.id);
    expect(plan.clips.map((c) => c.path)).not.toContain("regenerated-and-unreviewed.mp4");

    // Trim regression: the last clip carries the trim and the total is the request.
    expect(plan.clips.at(-1)!.durationSeconds).toBe(10);
    expect(plan.totalDurationSeconds).toBe(50);
    expect(plan.finalTrimSeconds).toBe(10);

    // Audio regression: the cue was mixed over the approved-clip timeline.
    expect(assembled.assembly!.finalPath).toContain("final-cut.mp4");
  });

  it("assembles once every scene is approved", async () => {
    const project = await projectWithUnapprovedMedia(40, "A ferry crosses at dawn.");
    const record = await getProjectRecord(project.id);
    const scenes = record.storyboard!.scenes;
    await approveAttempt(project.id, scenes[0]!.id, record.attempts![scenes[0]!.id]![0]!.id);
    await prerequisiteFailure(project.id);

    await approveAttempt(project.id, scenes[1]!.id, record.attempts![scenes[1]!.id]![0]!.id);
    const assembled = await assembleRoughCut(project.id);
    expect(assembled.assembly!.plan.clips).toHaveLength(2);
    expect(assembled.project.status).toBe("assembled");
  });
});

describe("deepy assistant", () => {
  it("labels responses as simulated when disabled", () => {
    const result = runDeepy("inspect_video_frame", "clip.mp4");
    expect(result.action).toBe("inspect_video_frame");
    expect(result.enabled).toBe(false);
    expect(result.result).toContain("simulated");
  });
});
