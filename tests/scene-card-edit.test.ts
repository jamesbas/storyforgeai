import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  updateSceneCard,
} from "@/lib/services/project-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";

/**
 * Correcting a scene card by hand.
 *
 * Prompts were editable and the card that produces them was not, which had it
 * backwards: a prompt agent given "the men's hands are seen tossing cards"
 * writes a shot of hands however many times it is asked, so rewriting the
 * prompts of a wrong card only produces the wrong shot again.
 */

async function seeded() {
  const project = await createProject({
    concept: "Four men play poker while Tracey watches.",
    requestedDurationSeconds: 60,
  });
  return generateStoryboard(project.id);
}

describe("editing a scene card", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("stores the corrected wording", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;

    const after = await updateSceneCard(record.project.id, scene.id, {
      actionDescription: "Four men in polo shirts sit around the table tossing cards.",
      visualDescription: "A wide shot of four men at a cluttered dining table.",
    });

    const edited = after.storyboard!.scenes.find((s) => s.id === scene.id)!;
    expect(edited.actionDescription).toContain("Four men in polo shirts");
    expect(edited.visualDescription).toContain("four men");
  });

  /** Timing and identity are derived; a hand edit must not move them. */
  it("leaves the derived fields alone", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[1]!;

    const after = await updateSceneCard(record.project.id, scene.id, { title: "A new title" });
    const edited = after.storyboard!.scenes.find((s) => s.id === scene.id)!;

    expect(edited.title).toBe("A new title");
    expect(edited.sceneNumber).toBe(scene.sceneNumber);
    expect(edited.startTimeSeconds).toBe(scene.startTimeSeconds);
    expect(edited.endTimeSeconds).toBe(scene.endTimeSeconds);
    expect(edited.id).toBe(scene.id);
  });

  it("leaves the other scenes alone", async () => {
    const record = await seeded();
    const scenes = record.storyboard!.scenes;

    const after = await updateSceneCard(record.project.id, scenes[0]!.id, { title: "Changed" });
    expect(after.storyboard!.scenes[1]!.actionDescription).toBe(scenes[1]!.actionDescription);
    expect(after.storyboard!.scenes).toHaveLength(scenes.length);
  });

  /** The prompts are deliberately untouched, and the panel says so. */
  it("does not rewrite the prompts on its own", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;

    const after = await updateSceneCard(record.project.id, scene.id, { title: "Changed" });
    const edited = after.storyboard!.scenes.find((s) => s.id === scene.id)!;
    expect(edited.prompts.startFramePrompt).toBe(scene.prompts.startFramePrompt);
  });

  it("records what it did", async () => {
    const record = await seeded();
    const after = await updateSceneCard(record.project.id, record.storyboard!.scenes[0]!.id, {
      title: "Changed",
    });
    expect(after.history?.some((h) => h.action === "scene.card_edited")).toBe(true);
  });

  it("refuses an empty patch", async () => {
    const record = await seeded();
    await expect(
      updateSceneCard(record.project.id, record.storyboard!.scenes[0]!.id, {}),
    ).rejects.toThrow();
  });

  /**
   * Dialogue is the only source of speech in a clip: the video model speaks it
   * word for word. It was written as an "optional note" and the planning model
   * dropped it, so being able to put it back by hand matters.
   */
  it("stores dialogue and narration", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;

    const after = await updateSceneCard(record.project.id, scene.id, {
      dialogue: [
        { character: "Mike", line: "You in or out? Clock's running." },
        { character: "Dave", line: "Give me a second. I'm thinking." },
      ],
      narrationText: "Every Thursday, the same four men.",
    });

    const edited = after.storyboard!.scenes.find((s) => s.id === scene.id)!;
    expect(edited.dialogue).toHaveLength(2);
    expect(edited.dialogue?.[1]?.character).toBe("Dave");
    expect(edited.narrationText).toContain("Every Thursday");
  });

  it("can clear dialogue for a deliberately wordless scene", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;

    await updateSceneCard(record.project.id, scene.id, {
      dialogue: [{ character: "Mike", line: "Deal." }],
    });
    const after = await updateSceneCard(record.project.id, scene.id, { dialogue: [] });

    expect(after.storyboard!.scenes.find((s) => s.id === scene.id)!.dialogue).toEqual([]);
  });

  it("refuses a scene that does not exist", async () => {
    const record = await seeded();
    await expect(
      updateSceneCard(record.project.id, "no-such-scene", { title: "x" }),
    ).rejects.toThrow();
  });
});
