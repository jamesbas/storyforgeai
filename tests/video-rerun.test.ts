import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Rebuilding a clip without re-rendering the frames it sits between.
 *
 * Changing a video prompt or a motion LoRA does not change the keyframes, but a
 * full regeneration re-renders both of them anyway — two image jobs per scene,
 * thrown away, to arrive back where you started.
 */

const record = (overrides: Partial<ProjectRecord> = {}) =>
  ({
    project: {
      id: "p1",
      sceneContinuity: "reuse_end_frame",
      generationMode: "video_segments",
    },
    storyboard: {
      scenes: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, sceneNumber: n })),
    },
    attempts: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [`s${n}`, [{ startImagePath: `start-${n}.png` }]]),
    ),
    ...overrides,
  }) as unknown as ProjectRecord;

beforeEach(async () => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("video-only rerun scope", () => {
  it("honours the selection on a frame-chained project", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    const scope = videoRerunScope(record(), ["s2"]);

    // `reuse_end_frame` chains keyframes, and a clip rerun does not touch those.
    expect(scope.sceneIds).toEqual(["s2"]);
    expect(scope.cascaded).toBe(false);
  });

  it("leaves a cut project's selection alone too", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    const base = record();
    const cut = { ...base, project: { ...base.project, sceneContinuity: "cut" } } as ProjectRecord;

    expect(videoRerunScope(cut, ["s3"]).sceneIds).toEqual(["s3"]);
  });

  /**
   * The whole reason this needed a decision. On `continue_video` each clip is
   * built from the previous scene's *clip*, so rebuilding one in the middle
   * leaves every later scene continuing from something that no longer exists.
   */
  it("extends forward from the earliest scene when clips are chained", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    const base = record();
    const chained = {
      ...base,
      project: { ...base.project, sceneContinuity: "continue_video" },
    } as ProjectRecord;

    const scope = videoRerunScope(chained, ["s2"]);
    expect(scope.sceneIds).toEqual(["s2", "s3", "s4"]);
    expect(scope.cascaded).toBe(true);
  });

  it("reports no cascade when the selection already reached the end", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    const base = record();
    const chained = {
      ...base,
      project: { ...base.project, sceneContinuity: "continue_video" },
    } as ProjectRecord;

    // Nothing was added, so the notice would be a lie.
    expect(videoRerunScope(chained, ["s4"]).cascaded).toBe(false);
  });

  it("picks the earliest of a scattered selection, not the first listed", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    const base = record();
    const chained = {
      ...base,
      project: { ...base.project, sceneContinuity: "continue_video" },
    } as ProjectRecord;

    expect(videoRerunScope(chained, ["s3", "s2"]).sceneIds).toEqual(["s2", "s3", "s4"]);
  });

  it("returns nothing for a selection that matches no scene", async () => {
    const { videoRerunScope } = await import("@/lib/services/scene-queue");
    expect(videoRerunScope(record(), ["nope"]).sceneIds).toEqual([]);
  });
});

describe("rebuilding one scene's clip", () => {
  const seed = async () => {
    const projects = await import("@/lib/services/project-service");
    const media = await import("@/lib/services/media-service");
    const project = await projects.createProject({
      concept: "A paper plane crosses a city.",
      requestedDurationSeconds: 40,
    });
    const withStoryboard = await projects.generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    const generated = await media.generateSceneMedia(project.id, sceneId);
    return { projects, media, projectId: project.id, sceneId, generated };
  };

  it("keeps the frames and renders only a new clip", async () => {
    const { media, projectId, sceneId, generated } = await seed();
    const before = generated.attempts![sceneId]![0]!;

    const after = await media.regenerateSceneVideo(projectId, sceneId);
    const attempts = after.attempts![sceneId]!;
    expect(attempts).toHaveLength(2);

    const latest = attempts[1]!;
    // The point of the whole feature: the images are not re-rendered.
    expect(latest.startImagePath).toBe(before.startImagePath);
    expect(latest.endImagePath).toBe(before.endImagePath);
    expect(latest.videoPath).toBeTruthy();
    expect(latest.approved).toBe(false);
  });

  it("carries the swap provenance forward so undo still works", async () => {
    const { media, projectId, sceneId, generated } = await seed();
    const before = generated.attempts![sceneId]![0]!;

    const after = await media.regenerateSceneVideo(projectId, sceneId);
    const latest = after.attempts![sceneId]![1]!;
    expect(latest.startImageSourcePath).toBe(before.startImageSourcePath);
    expect(latest.endImageSourcePath).toBe(before.endImageSourcePath);
  });

  /** Nothing to reuse means nothing to rebuild; a full pass is the right answer. */
  it("refuses a scene that has never been generated", async () => {
    const projects = await import("@/lib/services/project-service");
    const media = await import("@/lib/services/media-service");
    const project = await projects.createProject({
      concept: "A paper plane crosses a city.",
      requestedDurationSeconds: 40,
    });
    const withStoryboard = await projects.generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[1]!.id;

    await expect(media.regenerateSceneVideo(project.id, sceneId)).rejects.toThrow(
      /no generated frames/i,
    );
  });

  it("refuses a project whose mode renders no clips", async () => {
    const projects = await import("@/lib/services/project-service");
    const media = await import("@/lib/services/media-service");
    const project = await projects.createProject({
      concept: "A paper plane crosses a city.",
      requestedDurationSeconds: 40,
      generationMode: "keyframes_only",
    });
    const withStoryboard = await projects.generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    await media.generateSceneMedia(project.id, sceneId);

    await expect(media.regenerateSceneVideo(project.id, sceneId)).rejects.toThrow(
      /does not render clips/i,
    );
  });
});
