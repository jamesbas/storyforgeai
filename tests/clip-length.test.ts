import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  updateProjectModels,
} from "@/lib/services/project-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Retuning a project after creation.
 *
 * The video model stays editable for the life of a project, so a model pinned
 * later can want a different clip length than the one chosen at intake. Before
 * this the only lever was recreating the project.
 */

async function planned(concept: string): Promise<ProjectRecord> {
  const created = await createProject({ concept, requestedDurationSeconds: 60 });
  return generateStoryboard(created.id);
}

beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

describe("changing clip length after a storyboard exists", () => {
  it("retimes every scene without adding or removing any", async () => {
    const record = await planned("A diver surfaces beside an abandoned rig at dusk.");
    const before = record.storyboard!.scenes.length;

    const updated = await updateProjectModels(record.project.id, { segmentSeconds: 15 });

    expect(updated.project.segmentSeconds).toBe(15);
    expect(updated.storyboard!.scenes.length).toBe(before);
    expect(updated.project.segmentCount).toBe(record.project.segmentCount);
    expect(updated.storyboard!.scenes.every((s) => s.targetDurationSeconds === 15)).toBe(true);
  });

  it("shortens the generated runtime rather than re-planning the story", async () => {
    const record = await planned("A courier crosses a frozen lake carrying a sealed box.");
    const count = record.project.segmentCount;

    const updated = await updateProjectModels(record.project.id, { segmentSeconds: 15 });

    expect(updated.project.generatedDurationSeconds).toBe(count * 15);
    // Requested runtime is what the operator asked for and is not rewritten.
    expect(updated.project.requestedDurationSeconds).toBe(
      record.project.requestedDurationSeconds,
    );
  });

  it("never reports a negative trim once the piece is shorter than requested", async () => {
    const record = await planned("A signal repeats from a valley nobody has mapped.");
    const updated = await updateProjectModels(record.project.id, { segmentSeconds: 5 });
    expect(updated.project.finalTrimSeconds).toBeGreaterThanOrEqual(0);
  });

  it("leaves the storyboard alone when the length is unchanged", async () => {
    const record = await planned("Two brothers repair a radio during a blackout.");
    const updated = await updateProjectModels(record.project.id, {
      segmentSeconds: record.project.segmentSeconds,
    });
    expect(updated.storyboard).toEqual(record.storyboard);
  });

  it("rejects a length outside the supported range", async () => {
    const record = await planned("A cartographer erases a village from her own map.");
    await expect(
      updateProjectModels(record.project.id, { segmentSeconds: 45 }),
    ).rejects.toThrow();
  });
});

describe("changing clip length before a storyboard exists", () => {
  it("re-derives the scene count from the requested runtime", async () => {
    const created = await createProject({
      concept: "A night watchman follows footprints that stop halfway across a bridge.",
      requestedDurationSeconds: 60,
      segmentSeconds: 20,
    });
    expect(created.segmentCount).toBe(3);

    const updated = await updateProjectModels(created.id, { segmentSeconds: 15 });

    // Nothing is planned yet, so the runtime is preserved by adding scenes.
    expect(updated.project.segmentCount).toBe(4);
    expect(updated.project.generatedDurationSeconds).toBe(60);
  });
});

describe("clip and keyframe resolution are separate dials", () => {
  it("defaults clips to the keyframe preset", async () => {
    const created = await createProject({
      concept: "A beekeeper watches a swarm settle on a parked car.",
      requestedDurationSeconds: 40,
      resolutionPreset: "high",
    });
    expect(created.resolutionPreset).toBe("high");
    expect(created.videoResolutionPreset).toBeUndefined();
  });

  it("lowers clips without touching the keyframes", async () => {
    const created = await createProject({
      concept: "A lighthouse keeper repaints the lamp room in a gale.",
      requestedDurationSeconds: 40,
      resolutionPreset: "high",
    });

    const updated = await updateProjectModels(created.id, { videoResolutionPreset: "draft" });

    expect(updated.project.videoResolutionPreset).toBe("draft");
    expect(updated.project.resolutionPreset).toBe("high");
  });
});
