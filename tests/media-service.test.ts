import { describe, it, expect } from "vitest";
import {
  createProject,
  generateStoryboard,
} from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { ValidationError } from "@/lib/errors";
import { sceneAttemptSchema } from "@/lib/schemas/generation";

describe("media generation service — scene attempt lifecycle", () => {
  it("generates start/end/video, stores an attempt, and runs QC", async () => {
    const project = await createProject({
      concept: "A paper plane crosses a city.",
      requestedDurationSeconds: 40,
      qcEnabled: true,
    });
    const withStoryboard = await generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;

    const record = await generateSceneMedia(project.id, sceneId);
    const attempts = record.attempts?.[sceneId] ?? [];
    expect(attempts).toHaveLength(1);

    const attempt = attempts[0]!;
    expect(() => sceneAttemptSchema.parse(attempt)).not.toThrow();
    expect(attempt.startImagePath).toBeTruthy();
    expect(attempt.endImagePath).toBeTruthy();
    expect(attempt.videoPath).toBeTruthy();
    expect(attempt.qcResult?.passed).toBe(true);
    expect(attempt.settingsIds).toHaveLength(3);

    const scene = record.storyboard!.scenes.find((s) => s.id === sceneId)!;
    expect(scene.status).toBe("generated");
  });

  it("supports retry/regeneration with an incrementing attempt number", async () => {
    const project = await createProject({
      concept: "A cat chases a laser across rooftops.",
      requestedDurationSeconds: 20,
    });
    const withStoryboard = await generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;

    await generateSceneMedia(project.id, sceneId);
    const record = await generateSceneMedia(project.id, sceneId);
    const attempts = record.attempts?.[sceneId] ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.attemptNumber).toBe(2);
  });

  it("approves an attempt and marks the scene approved", async () => {
    const project = await createProject({
      concept: "A diver meets a whale.",
      requestedDurationSeconds: 20,
    });
    const withStoryboard = await generateStoryboard(project.id);
    const sceneId = withStoryboard.storyboard!.scenes[0]!.id;
    const generated = await generateSceneMedia(project.id, sceneId);
    const attemptId = generated.attempts![sceneId]![0]!.id;

    const record = await approveAttempt(project.id, sceneId, attemptId);
    expect(record.attempts![sceneId]![0]!.approved).toBe(true);
    expect(record.storyboard!.scenes.find((s) => s.id === sceneId)!.status).toBe("approved");
  });

  it("refuses to generate media before a storyboard exists", async () => {
    const project = await createProject({
      concept: "No storyboard here.",
      requestedDurationSeconds: 20,
    });
    await expect(
      generateSceneMedia(project.id, `${project.id}-scene-001`),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
