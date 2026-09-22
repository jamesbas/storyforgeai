import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "@/lib/config";
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

/**
 * Replacing a cut rather than accumulating them.
 *
 * The name now carries a timestamp, so a re-assembly no longer lands on the
 * same filename and would otherwise leave every previous cut behind. Only the
 * latest is kept, which is also what quietly migrates a project still holding
 * the old `rough-cut.mp4`.
 */
describe("re-assembling a project", () => {
  it("removes the cut it supersedes, including a legacy rough-cut.mp4", async () => {
    const project = await projectWithAllMedia(40);
    await assembleRoughCut(project.id);

    // Stand the project back up as one assembled before this naming existed.
    const assemblyDir = path.join(config.dataDir, project.id, "assembly");
    const legacy = path.join(assemblyDir, "rough-cut.mp4");
    await fs.mkdir(assemblyDir, { recursive: true });
    await fs.writeFile(legacy, "an older cut");

    const before = await getProjectRecord(project.id);
    await repository.update(project.id, {
      ...before,
      assembly: { ...before.assembly!, roughCutPath: legacy },
    });

    const after = await assembleRoughCut(project.id);

    await expect(fs.access(legacy)).rejects.toThrow();
    expect(after.assembly!.roughCutPath).not.toBe(legacy);
    expect(path.basename(after.assembly!.roughCutPath)).toMatch(/-rough-cut\.mp4$/);
  });

  /** A stored path is the one input here that was not derived a moment ago. */
  it("never deletes a file outside the project's own assembly folder", async () => {
    const project = await projectWithAllMedia(40);
    await assembleRoughCut(project.id);

    const outsider = path.join(config.dataDir, "not-ours.mp4");
    await fs.writeFile(outsider, "somebody else's file");

    const before = await getProjectRecord(project.id);
    await repository.update(project.id, {
      ...before,
      assembly: { ...before.assembly!, roughCutPath: outsider },
    });

    await assembleRoughCut(project.id);

    await expect(fs.access(outsider)).resolves.toBeUndefined();
    await fs.rm(outsider, { force: true });
  });

  it("leaves the record pointing at a cut that exists", async () => {
    const project = await projectWithAllMedia(40);
    const first = await assembleRoughCut(project.id);
    await fs.mkdir(path.dirname(first.assembly!.roughCutPath), { recursive: true });
    await fs.writeFile(first.assembly!.roughCutPath, "the first cut");

    const second = await assembleRoughCut(project.id);

    // Same minute, so the same name: the file is replaced in place rather than
    // deleted out from under the record that names it.
    await expect(fs.access(second.assembly!.roughCutPath)).resolves.toBeUndefined();
  });
});

describe("assembly service", () => {
  it("assembles a rough cut from approved clips", async () => {
    const project = await projectWithAllMedia(40);
    const record = await assembleRoughCut(project.id);
    expect(record.assembly).toBeDefined();
    expect(() => assemblySchema.parse(record.assembly)).not.toThrow();
    expect(record.assembly!.plan.clips).toHaveLength(2);
    // Named for the project and the moment rather than `rough-cut.mp4`, which
    // every project produced and which is what the download header carries.
    expect(path.basename(record.assembly!.roughCutPath)).toMatch(
      /^.+-\d{4}-\d{2}-\d{2}-\d{4}-rough-cut\.mp4$/,
    );
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
    expect(path.basename(assembled.assembly!.finalPath!)).toMatch(
      /^.+-\d{4}-\d{2}-\d{2}-\d{4}-final-cut\.mp4$/,
    );
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
