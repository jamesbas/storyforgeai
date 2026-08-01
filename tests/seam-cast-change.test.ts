import { describe, it, expect } from "vitest";
import { seamBreak } from "@/lib/media/seam";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * A frame two scenes disagree about.
 *
 * Under `reuse_end_frame` one file is a scene's end frame and the next scene's
 * start frame. Scene 1 was planned faceless and scene 2 introduced a character
 * whose face is in shot, so the shared frame was swept into the face swap on
 * scene 2's behalf — and a shot of four men came back with a woman's face
 * grafted into it, on a scene whose "Face in frame" box was clear.
 *
 * The swap gate was right. The two scenes should never have been sharing a
 * frame: they do not describe the same picture.
 */

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "p1-scene-001",
    projectId: "p1",
    sceneNumber: 1,
    title: "The Ritual",
    visualDescription: "Wide shot of a cluttered dining room.",
    actionDescription: "Cards land on the table.",
    cameraMovement: "Static wide shot",
    transitionIn: "Continuous",
    transitionOut: "Continuous",
    subjectFaceVisible: true,
    charactersPresent: [],
    continuityNotes: [],
    wardrobeChanges: [],
    sceneObjective: "Establish",
    storyBeat: "Beat",
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    status: "planned",
    prompts: {
      startFramePrompt: "Wide shot, eye level, four men at a table.",
      endFramePrompt: "Wide shot, eye level, cards scattered on the table.",
      videoPromptSegment: "",
      videoNegativePrompt: "",
      imageNegativePrompt: "",
      promptQualityChecklist: [],
    },
    ...overrides,
  } as Scene;
}

describe("inheriting a frame across a change of who is in shot", () => {
  /** The exact Poker Night configuration. */
  it("refuses when one scene is faceless and the next is not", () => {
    const previous = scene({ subjectFaceVisible: false });
    const next = scene({ sceneNumber: 2, subjectFaceVisible: true });

    const broken = seamBreak(previous, next);
    expect(broken?.reason).toBe("face_visibility_change");
    expect(broken?.detail).toBe("face enters frame");
  });

  it("refuses in the other direction too", () => {
    const broken = seamBreak(scene(), scene({ sceneNumber: 2, subjectFaceVisible: false }));
    expect(broken?.detail).toBe("face leaves frame");
  });

  /**
   * Inheriting across an arrival renders the wrong people: this scene's own
   * start-frame prompt, the one that introduces them, is never sent.
   */
  it("refuses when a character arrives", () => {
    const previous = scene({ charactersPresent: [] });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Tracey"] });

    const broken = seamBreak(previous, next);
    expect(broken?.reason).toBe("cast_change");
    expect(broken?.detail).toContain("Tracey enters");
  });

  it("refuses when a character leaves", () => {
    const previous = scene({ charactersPresent: ["Tracey", "Mike"] });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Mike"] });

    expect(seamBreak(previous, next)?.detail).toContain("Tracey leaves");
  });

  it("still inherits when the shot genuinely continues", () => {
    const previous = scene({ charactersPresent: ["Tracey"] });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Tracey"] });
    expect(seamBreak(previous, next)).toBeNull();
  });

  /** Order is not membership; the same people in a different order is no change. */
  it("does not mistake a reordered list for a change", () => {
    const previous = scene({ charactersPresent: ["Mike", "Tracey"] });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Tracey", "Mike"] });
    expect(seamBreak(previous, next)).toBeNull();
  });

  /** Shot size is the stronger evidence and is still reported first. */
  it("reports a shot-size change ahead of a cast change", () => {
    const previous = scene({ charactersPresent: [] });
    const next = scene({
      sceneNumber: 2,
      charactersPresent: ["Tracey"],
      prompts: { ...scene().prompts, startFramePrompt: "Close-up, eye level, her hands." },
    });
    expect(seamBreak(previous, next)?.reason).toBe("shot_size_change");
  });
});
