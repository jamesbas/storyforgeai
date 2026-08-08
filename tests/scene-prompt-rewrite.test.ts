import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
  regenerateAllScenePrompts,
  regenerateScenePrompts,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { latestExecution } from "@/lib/schemas/provenance";

/**
 * Rewriting one scene's prompts.
 *
 * Regenerating the storyboard to fix one clumsy shot discards seventeen that
 * were fine, along with every hand edit. The prompt agents are two calls per
 * scene, so there is no reason it has to be all or nothing.
 */

async function seeded() {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 80,
  });
  return generateStoryboard(project.id);
}

describe("rewriting one scene's prompts", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("leaves every other scene's prompts exactly as they were", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const target = scenes[1]!;

    // A hand edit elsewhere is the thing a full regeneration would destroy.
    await updateScenePrompts(record.project.id, scenes[2]!.id, {
      startFramePrompt: "A hand-written prompt that must survive.",
    });

    const after = await regenerateScenePrompts(record.project.id, target.id);
    const byId = new Map(after.storyboard!.scenes.map((s) => [s.id, s] as const));

    expect(byId.get(scenes[2]!.id)!.prompts.startFramePrompt).toBe(
      "A hand-written prompt that must survive.",
    );
    expect(byId.get(scenes[0]!.id)!.prompts.startFramePrompt).toBe(
      scenes[0]!.prompts.startFramePrompt,
    );
  });

  /** The card is the input, not the output: rewriting must not restate it. */
  it("leaves the scene's own card alone", async () => {
    const record = await seeded();
    const target = record.storyboard!.scenes[1]!;

    const after = await regenerateScenePrompts(record.project.id, target.id);
    const rebuilt = after.storyboard!.scenes.find((s) => s.id === target.id)!;

    expect(rebuilt.visualDescription).toBe(target.visualDescription);
    expect(rebuilt.actionDescription).toBe(target.actionDescription);
    expect(rebuilt.cameraMovement).toBe(target.cameraMovement);
    expect(rebuilt.sceneNumber).toBe(target.sceneNumber);
  });

  it("keeps the scene count and order", async () => {
    const record = await seeded();
    const before = record.storyboard!.scenes.map((s) => s.id);
    const after = await regenerateScenePrompts(record.project.id, before[1]!);
    expect(after.storyboard!.scenes.map((s) => s.id)).toEqual(before);
  });

  it("records what it did", async () => {
    const record = await seeded();
    const after = await regenerateScenePrompts(record.project.id, record.storyboard!.scenes[0]!.id);
    expect(after.history?.some((h) => h.action === "scene.prompts_rewritten")).toBe(true);
  });

  it("records the run that produced the new prompts", async () => {
    // Without this the scene keeps the provenance of whichever run first wrote
    // it, so the version the storyboard checks staleness against describes
    // prompts that have since been replaced — and the warning never clears.
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    const before = latestExecution(record.executions, `${scene.id}.video_prompt`);
    const after = await regenerateScenePrompts(record.project.id, scene.id);
    const now = latestExecution(after.executions, `${scene.id}.video_prompt`);

    expect(now).toBeDefined();
    expect(now?.executionId).not.toBe(before?.executionId);
  });

  it("refuses a scene that does not exist", async () => {
    const record = await seeded();
    await expect(regenerateScenePrompts(record.project.id, "no-such-scene")).rejects.toThrow();
  });

  it("records a run for every scene when the whole storyboard is rewritten", async () => {
    const record = await seeded();
    const before = record.storyboard!.scenes.map(
      (scene) => latestExecution(record.executions, `${scene.id}.video_prompt`)?.executionId,
    );
    const after = await regenerateAllScenePrompts(record.project.id);

    after.storyboard!.scenes.forEach((scene, index) => {
      const now = latestExecution(after.executions, `${scene.id}.video_prompt`);
      expect(now).toBeDefined();
      expect(now?.executionId).not.toBe(before[index]);
    });
  });

  it("refuses before there is a storyboard", async () => {
    const project = await createProject({
      concept: "Nothing planned yet.",
      requestedDurationSeconds: 16,
    });
    await expect(regenerateScenePrompts(project.id, "any")).rejects.toThrow(
      /Generate a storyboard/,
    );
    expect(await getProjectRecord(project.id)).toBeDefined();
  });
});
