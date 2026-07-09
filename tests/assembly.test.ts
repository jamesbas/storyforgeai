import { describe, it, expect } from "vitest";
import {
  buildConcatArgs,
  buildConcatListFile,
  buildTrimArgs,
  MockFfmpegRunner,
} from "@/lib/media/ffmpeg";
import { buildFinalCutPlan } from "@/lib/media/assembly";
import { finalCutPlanSchema } from "@/lib/schemas/assembly";
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

  it("throws when a scene has no generated video", async () => {
    const record = await makeRecordWithMedia(40);
    delete record.attempts![record.storyboard!.scenes[0]!.id];
    expect(() => buildFinalCutPlan(record)).toThrow();
  });
});
