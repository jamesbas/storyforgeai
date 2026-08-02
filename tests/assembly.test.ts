import { describe, it, expect } from "vitest";
import {
  buildConcatArgs,
  buildConcatListFile,
  buildTrimArgs,
  MockFfmpegRunner,
} from "@/lib/media/ffmpeg";
import {
  assemblyPrerequisites,
  assemblyReadiness,
  buildFinalCutPlan,
  selectApprovedAttempt,
} from "@/lib/media/assembly";
import { finalCutClipSchema, finalCutPlanSchema } from "@/lib/schemas/assembly";
import { PrerequisiteError } from "@/lib/errors";
import { computeSegmentation } from "@/lib/duration";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import type { Project } from "@/lib/schemas/project";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";

describe("ffmpeg builders", () => {
  it("builds a concat list file with escaped paths", () => {
    const list = buildConcatListFile(["a.mp4", "b.mp4"]);
    expect(list).toContain("file 'a.mp4'");
    expect(list).toContain("file 'b.mp4'");
  });

  it("builds copy-concat args", () => {
    expect(buildConcatArgs("clips.txt", "out.mp4")).toEqual([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "clips.txt",
      "-c",
      "copy",
      "out.mp4",
    ]);
  });

  it("builds trim args for a fixed duration", () => {
    expect(buildTrimArgs("in.mp4", "out.mp4", 10)).toEqual([
      "-i",
      "in.mp4",
      "-t",
      "10",
      "-c",
      "copy",
      "out.mp4",
    ]);
  });

  it("mock runner returns the output path", async () => {
    const runner = new MockFfmpegRunner();
    const out = await runner.concat(["a.mp4", "b.mp4"], "rough.mp4");
    expect(out).toBe("rough.mp4");
    expect(runner.lastArgs).toContain("concat");
  });
});

function makeProject(requestedDurationSeconds: number): Project {
  const seg = computeSegmentation(requestedDurationSeconds);
  const now = new Date().toISOString();
  return {
    id: "assembly-project",
    title: "Assembly Project",
    concept: "A comet crosses the sky.",
    requestedDurationSeconds,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "epic",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

async function makeRecordWithMedia(requestedDurationSeconds: number): Promise<ProjectRecord> {
  const project = makeProject(requestedDurationSeconds);
  const storyboard = await runStoryboardOrchestrator(project, { provider: null });
  const attempts: Record<string, SceneAttempt[]> = {};
  for (const scene of storyboard.scenes) {
    attempts[scene.id] = [
      {
        id: `${scene.id}-a1`,
        sceneId: scene.id,
        attemptNumber: 1,
        startImagePath: `${scene.id}-start.png`,
        endImagePath: `${scene.id}-end.png`,
        videoPath: `${scene.id}-video.mp4`,
        settingsIds: [],
        approved: true,
        createdAt: new Date().toISOString(),
      },
    ];
  }
  return { project, storyboard, attempts };
}

function attempt(
  sceneId: string,
  attemptNumber: number,
  overrides: { approved: boolean; videoPath?: string },
): SceneAttempt {
  return {
    id: `${sceneId}-a${attemptNumber}`,
    sceneId,
    attemptNumber,
    settingsIds: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("final cut plan", () => {
  it("assembles one clip per scene and totals the requested runtime", async () => {
    const record = await makeRecordWithMedia(90); // 5 scenes, 10s trim
    const plan = buildFinalCutPlan(record);
    expect(() => finalCutPlanSchema.parse(plan)).not.toThrow();
    expect(plan.clips).toHaveLength(5);
    // Last clip trimmed to 20 - 10 = 10s; total = 4*20 + 10 = 90 (requested).
    expect(plan.clips.at(-1)!.durationSeconds).toBe(10);
    expect(plan.totalDurationSeconds).toBe(90);
    expect(plan.finalTrimSeconds).toBe(10);
  });

  it("records the approved attempt id on every clip", async () => {
    const record = await makeRecordWithMedia(40);
    const plan = buildFinalCutPlan(record);
    for (const clip of plan.clips) {
      expect(clip.attemptId).toBe(`${clip.sceneId}-a1`);
    }
  });

  it("throws when a scene has no generated video", async () => {
    const record = await makeRecordWithMedia(40);
    delete record.attempts![record.storyboard!.scenes[0]!.id];
    expect(() => buildFinalCutPlan(record)).toThrow(PrerequisiteError);
  });
});

describe("approved-attempt selection", () => {
  it("keeps an older approved attempt over a newer unapproved one", async () => {
    const record = await makeRecordWithMedia(20);
    const sceneId = record.storyboard!.scenes[0]!.id;
    record.attempts![sceneId] = [
      attempt(sceneId, 1, { approved: true, videoPath: "approved-take.mp4" }),
      attempt(sceneId, 2, { approved: false, videoPath: "newer-take.mp4" }),
    ];

    expect(selectApprovedAttempt(record, sceneId).attempt?.id).toBe(`${sceneId}-a1`);

    const plan = buildFinalCutPlan(record);
    expect(plan.clips[0]!.path).toBe("approved-take.mp4");
    expect(plan.clips[0]!.attemptId).toBe(`${sceneId}-a1`);
  });

  it("never falls back to the latest attempt when nothing is approved", async () => {
    const record = await makeRecordWithMedia(20);
    const sceneId = record.storyboard!.scenes[0]!.id;
    record.attempts![sceneId] = [
      attempt(sceneId, 1, { approved: false, videoPath: "take-1.mp4" }),
      attempt(sceneId, 2, { approved: false, videoPath: "take-2.mp4" }),
    ];

    expect(selectApprovedAttempt(record, sceneId)).toEqual({ reason: "no_approved_attempt" });
    expect(() => buildFinalCutPlan(record)).toThrow(PrerequisiteError);
  });

  it("rejects an approved attempt that has no video", async () => {
    const record = await makeRecordWithMedia(20);
    const sceneId = record.storyboard!.scenes[0]!.id;
    record.attempts![sceneId] = [attempt(sceneId, 1, { approved: true, videoPath: undefined })];

    expect(selectApprovedAttempt(record, sceneId)).toEqual({
      reason: "approved_attempt_missing_video",
    });
    expect(assemblyPrerequisites(record)[0]!.reason).toBe("approved_attempt_missing_video");
  });

  it("treats a blank video path as missing", async () => {
    const record = await makeRecordWithMedia(20);
    const sceneId = record.storyboard!.scenes[0]!.id;
    record.attempts![sceneId] = [attempt(sceneId, 1, { approved: true, videoPath: "   " })];

    expect(selectApprovedAttempt(record, sceneId).attempt).toBeUndefined();
  });

  it("reports every blocking scene with id, number, title and reason", async () => {
    const record = await makeRecordWithMedia(60); // 3 scenes
    const scenes = record.storyboard!.scenes;
    // Scene 1 approved, scene 2 generated but unapproved, scene 3 not generated.
    record.attempts![scenes[1]!.id] = [
      attempt(scenes[1]!.id, 1, { approved: false, videoPath: "take.mp4" }),
    ];
    delete record.attempts![scenes[2]!.id];

    const missing = assemblyPrerequisites(record);
    expect(missing).toEqual([
      {
        sceneId: scenes[1]!.id,
        sceneNumber: 2,
        sceneTitle: scenes[1]!.title,
        reason: "no_approved_attempt",
      },
      {
        sceneId: scenes[2]!.id,
        sceneNumber: 3,
        sceneTitle: scenes[2]!.title,
        reason: "no_attempt",
      },
    ]);

    const readiness = assemblyReadiness(record);
    expect(readiness).toMatchObject({ ready: false, totalScenes: 3, approvedScenes: 1 });

    try {
      buildFinalCutPlan(record);
      expect.unreachable("assembly must not build a plan with unapproved scenes");
    } catch (err) {
      expect(err).toBeInstanceOf(PrerequisiteError);
      expect((err as PrerequisiteError).status).toBe(409);
      expect((err as PrerequisiteError).details).toEqual({ missingApprovals: missing });
    }
  });

  it("is ready only when every scene has an approved video", async () => {
    const record = await makeRecordWithMedia(40);
    expect(assemblyReadiness(record)).toMatchObject({
      ready: true,
      totalScenes: 2,
      approvedScenes: 2,
      missingApprovals: [],
    });
  });
});

describe("final cut clip compatibility", () => {
  it("parses a legacy clip that predates attempt provenance", () => {
    const legacy = {
      sceneId: "p-scene-001",
      sceneNumber: 1,
      path: "clip.mp4",
      durationSeconds: 20,
      transitionIn: "Cut",
      transitionOut: "Cut",
    };
    const parsed = finalCutClipSchema.parse(legacy);
    expect(parsed.attemptId).toBeUndefined();
    expect(parsed.path).toBe("clip.mp4");
  });
});
