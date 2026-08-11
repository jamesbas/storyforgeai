import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  duplicateProject,
  generateStoryboard,
  getProjectRecord,
  renameProject,
  updateProjectModels,
} from "@/lib/services/project-service";
import { generateSceneMedia } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { config } from "@/lib/config";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Renaming and copying a project.
 *
 * A copy exists so the same story can be re-run against different models, LoRAs
 * or continuity settings. That only works if everything describing *intent*
 * comes across and nothing describing a *render* does — otherwise one project's
 * media ends up attached to another.
 */

async function seeded(): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 40,
  });
  return generateStoryboard(created.id);
}

beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

/**
 * Automatic selection cannot rank the ~200 models WanGP publishes, so a new
 * project starts on a known-good pin rather than whatever the router lands on.
 * It is a starting value only: the Settings screen can move it, and an explicit
 * choice at creation is never overridden.
 */
describe("the image model a new project starts on", () => {
  it("pins the default", async () => {
    const created = await createProject({
      concept: "Two climbers wait out a storm in a bothy.",
      requestedDurationSeconds: 40,
    });
    expect(created.imageModel).toBe(config.defaults.imageModel);
  });

  it("leaves an explicit choice alone", async () => {
    const created = await createProject({
      concept: "Two climbers wait out a storm in a bothy.",
      requestedDurationSeconds: 40,
      imageModel: "qwen_image_20B",
    });
    expect(created.imageModel).toBe("qwen_image_20B");
  });

  /** Changing it afterwards has to stick, or the default is a trap. */
  it("can be changed afterwards", async () => {
    const created = await createProject({
      concept: "Two climbers wait out a storm in a bothy.",
      requestedDurationSeconds: 40,
    });
    await updateProjectModels(created.id, { imageModel: "flux2_klein_9b" });
    const record = await getProjectRecord(created.id);
    expect(record.project.imageModel).toBe("flux2_klein_9b");
  });
});

describe("renaming", () => {  it("changes the title and nothing else", async () => {
    const record = await seeded();
    const renamed = await renameProject(record.project.id, { title: "Lighthouse cut" });

    expect(renamed.project.title).toBe("Lighthouse cut");
    expect(renamed.project.concept).toBe(record.project.concept);
    expect(renamed.storyboard?.scenes).toHaveLength(record.storyboard!.scenes.length);
  });

  it("records the rename in history", async () => {
    const record = await seeded();
    const renamed = await renameProject(record.project.id, { title: "Lighthouse cut" });

    expect(renamed.history?.some((h) => h.action === "project.renamed")).toBe(true);
  });

  it("rejects a blank title", async () => {
    const record = await seeded();
    await expect(renameProject(record.project.id, { title: "   " })).rejects.toThrow();
  });
});

describe("copying", () => {
  it("carries settings and the storyboard across", async () => {
    const source = await seeded();
    const copy = await duplicateProject(source.project.id);
    const copied = await getProjectRecord(copy.id);

    expect(copy.id).not.toBe(source.project.id);
    expect(copy.concept).toBe(source.project.concept);
    expect(copy.segmentCount).toBe(source.project.segmentCount);
    expect(copied.storyboard?.scenes).toHaveLength(source.storyboard!.scenes.length);
  });

  /** The whole point: a copy starts unrendered. */
  it("does not carry generated media across", async () => {
    const source = await seeded();
    await generateSceneMedia(source.project.id, source.storyboard!.scenes[0]!.id);

    const copy = await duplicateProject(source.project.id);
    const copied = await getProjectRecord(copy.id);

    expect(copied.attempts ?? {}).toEqual({});
    expect(copied.assembly).toBeUndefined();
    expect(copied.storyboard!.scenes.every((s) => s.status === "planned")).toBe(true);
  });

  /**
   * Scene ids embed the project id, so a stale key would silently strand the
   * scene's pinned seed and LoRA override on a scene that no longer exists.
   */
  it("remaps scene ids and everything keyed by them", async () => {
    const source = await seeded();
    const sceneId = source.storyboard!.scenes[0]!.id;
    await updateProjectModels(source.project.id, {
      sceneLoras: { [sceneId]: { mode: "override", image: [], video: [] } },
    });
    // Generating mints a pinned seed for the scene.
    await generateSceneMedia(source.project.id, sceneId);

    const copy = await duplicateProject(source.project.id);
    const copied = await getProjectRecord(copy.id);
    const copiedSceneId = copied.storyboard!.scenes[0]!.id;

    expect(copiedSceneId).not.toBe(sceneId);
    expect(copiedSceneId.startsWith(copy.id)).toBe(true);
    expect(copied.storyboard!.scenes.every((s) => s.projectId === copy.id)).toBe(true);
    expect(Object.keys(copied.project.sceneLoras ?? {})).toEqual([copiedSceneId]);
    expect(copied.project.sceneSeeds?.[copiedSceneId]).toBeTypeOf("number");
    expect(copied.project.sceneSeeds?.[sceneId]).toBeUndefined();
  });

  it("keeps the seeds so the copy renders comparably", async () => {
    const source = await seeded();
    const sceneId = source.storyboard!.scenes[0]!.id;
    await generateSceneMedia(source.project.id, sceneId);
    const original = (await getProjectRecord(source.project.id)).project.sceneSeeds?.[sceneId];

    const copy = await duplicateProject(source.project.id);
    const copied = await getProjectRecord(copy.id);

    expect(copied.project.sceneSeeds?.[copied.storyboard!.scenes[0]!.id]).toBe(original);
  });

  it("numbers repeated copies rather than stacking suffixes", async () => {
    const source = await seeded();
    const first = await duplicateProject(source.project.id);
    const second = await duplicateProject(first.id);

    expect(first.title).toBe(`${source.project.title} (copy)`);
    expect(second.title).toBe(`${source.project.title} (copy 2)`);
  });

  it("notes the source in the copy's history", async () => {
    const source = await seeded();
    const copy = await duplicateProject(source.project.id);
    const copied = await getProjectRecord(copy.id);

    expect(copied.history?.[0]?.action).toBe("project.copied");
    expect(copied.history?.[0]?.detail).toBe(source.project.title);
  });
});
