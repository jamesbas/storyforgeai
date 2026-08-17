import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
  regenerateAllScenePrompts,
  regenerateScenePrompts,
  regenerateScenesPrompts,
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

/**
 * Rewriting a chosen few.
 *
 * The alternative to a selection is the all-scenes button, and reaching for
 * that to fix five scenes discards the hand edits on the other thirteen.
 */
describe("rewriting the prompts of several scenes at once", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("rewrites the ones picked and no others", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;
    const untouched = scenes[2]!;
    await updateScenePrompts(record.project.id, untouched.id, {
      startFramePrompt: "A hand-written prompt that must survive.",
    });

    const after = await regenerateScenesPrompts(record.project.id, [scenes[0]!.id, scenes[1]!.id]);
    const byId = new Map(after.storyboard!.scenes.map((s) => [s.id, s] as const));

    for (const scene of [scenes[0]!, scenes[1]!]) {
      const now = latestExecution(after.executions, `${scene.id}.video_prompt`);
      const before = latestExecution(record.executions, `${scene.id}.video_prompt`);
      expect(now?.executionId).not.toBe(before?.executionId);
    }
    expect(byId.get(untouched.id)!.prompts.startFramePrompt).toBe(
      "A hand-written prompt that must survive.",
    );
  });

  it("names every scene it rewrote in the history", async () => {
    const record = await seeded();
    const [a, b] = record.storyboard!.scenes;
    const after = await regenerateScenesPrompts(record.project.id, [a!.id, b!.id]);
    const entry = after.history?.find((h) => h.action === "scene.prompts_rewritten");

    expect(entry?.detail).toContain(`Scene ${a!.sceneNumber}`);
    expect(entry?.detail).toContain(`Scene ${b!.sceneNumber}`);
  });

  /** An empty selection means "all" to the clip queue; here it would be a silent no-op. */
  it("refuses an empty selection", async () => {
    const record = await seeded();
    await expect(regenerateScenesPrompts(record.project.id, [])).rejects.toThrow(/at least one/);
  });

  it("refuses the whole batch when one scene does not exist", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    const before = scene.prompts.startFramePrompt;

    await expect(
      regenerateScenesPrompts(record.project.id, [scene.id, "no-such-scene"]),
    ).rejects.toThrow();

    const after = await getProjectRecord(record.project.id);
    expect(after.storyboard!.scenes[0]!.prompts.startFramePrompt).toBe(before);
  });
});

/**
 * Rewriting one pass.
 *
 * Changing the video model pin says nothing about how a still frame should be
 * described, so a rewrite that spends a second model call per scene on the
 * image pass is buying a fresh copy of a prompt that was already right — and
 * paying for it with any wording that was typed by hand.
 */
describe("rewriting a single prompt pass", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  const executionIds = (record: Awaited<ReturnType<typeof seeded>>, pass: string) =>
    record.storyboard!.scenes.map(
      (scene) => latestExecution(record.executions, `${scene.id}.${pass}`)?.executionId,
    );

  it("re-runs the video pass and leaves the image pass untouched", async () => {
    const record = await seeded();
    const after = await regenerateAllScenePrompts(record.project.id, { passes: ["video"] });

    expect(executionIds(after, "video_prompt")).not.toEqual(executionIds(record, "video_prompt"));
    expect(executionIds(after, "image_prompt")).toEqual(executionIds(record, "image_prompt"));
  });

  it("keeps hand-edited frame prompts through a video-only rewrite", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[1]!;
    await updateScenePrompts(record.project.id, scene.id, {
      startFramePrompt: "A hand-written frame prompt that must survive.",
    });

    const after = await regenerateAllScenePrompts(record.project.id, { passes: ["video"] });
    const rewritten = after.storyboard!.scenes.find((s) => s.id === scene.id)!;

    expect(rewritten.prompts.startFramePrompt).toBe(
      "A hand-written frame prompt that must survive.",
    );
  });

  it("keeps the hand-edited clip prompt through an image-only rewrite", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[1]!;
    await updateScenePrompts(record.project.id, scene.id, {
      videoPromptSegment: "A hand-written clip prompt that must survive.",
    });

    const after = await regenerateAllScenePrompts(record.project.id, { passes: ["image"] });
    const rewritten = after.storyboard!.scenes.find((s) => s.id === scene.id)!;

    expect(rewritten.prompts.videoPromptSegment).toBe(
      "A hand-written clip prompt that must survive.",
    );
    expect(executionIds(after, "video_prompt")).toEqual(executionIds(record, "video_prompt"));
  });

  /**
   * The stamp is what the staleness banner reads. Restamping a pass that did
   * not run would clear the warning while leaving the prompts it warned about
   * exactly as they were.
   */
  it("does not restamp the clip family when the video pass is skipped", async () => {
    const record = await seeded();
    const before = record.storyboard!.scenes.map((s) => s.prompts.videoPromptFamily);
    const after = await regenerateAllScenePrompts(record.project.id, { passes: ["image"] });

    expect(after.storyboard!.scenes.map((s) => s.prompts.videoPromptFamily)).toEqual(before);
  });

  it("narrows a picked-scene rewrite to the pass asked for", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    const after = await regenerateScenesPrompts(record.project.id, [scene.id], {
      passes: ["video"],
    });

    expect(latestExecution(after.executions, `${scene.id}.video_prompt`)?.executionId).not.toBe(
      latestExecution(record.executions, `${scene.id}.video_prompt`)?.executionId,
    );
    expect(latestExecution(after.executions, `${scene.id}.image_prompt`)?.executionId).toBe(
      latestExecution(record.executions, `${scene.id}.image_prompt`)?.executionId,
    );
  });
});
