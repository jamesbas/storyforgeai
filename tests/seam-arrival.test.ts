import { describe, it, expect } from "vitest";
import { seamBreak } from "@/lib/media/seam";
import { seamDirective } from "@/lib/agents/continuity";
import type { Scene } from "@/lib/schemas/storyboard";
import type { Project } from "@/lib/schemas/project";

/**
 * Someone arriving mid-take.
 *
 * A character entering frame is not a cut — she walks in while the camera
 * holds — so the seam must survive it. Breaking the seam there would render a
 * new start frame with her already standing in it, which is a teleport, and
 * would manufacture exactly the cut the continuity setting was chosen to avoid.
 *
 * The seam working as intended is what depicts the entrance: the start frame is
 * the frame before she arrives, the clip carries her in, the end frame has her.
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

describe("the seam across an arrival", () => {
  /** The Poker Night configuration: nobody pinned in scene 1, Tracey in scene 2. */
  it("holds when a character arrives", () => {
    const previous = scene({ charactersPresent: [], subjectFaceVisible: false });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Tracey"], subjectFaceVisible: true });

    expect(seamBreak(previous, next)).toBeNull();
  });

  it("holds when a character leaves", () => {
    const previous = scene({ charactersPresent: ["Tracey", "Mike"] });
    const next = scene({ sceneNumber: 2, charactersPresent: ["Mike"] });

    expect(seamBreak(previous, next)).toBeNull();
  });

  /** A camera can tilt up to find a face without anyone cutting. */
  it("holds when a face comes into view", () => {
    const previous = scene({ subjectFaceVisible: false });
    const next = scene({ sceneNumber: 2, subjectFaceVisible: true });

    expect(seamBreak(previous, next)).toBeNull();
  });

  /** What the seam is actually for: evidence the storyboard planned a cut. */
  it("still breaks on a shot-size change", () => {
    const next = scene({
      sceneNumber: 2,
      prompts: { ...scene().prompts, startFramePrompt: "Close-up, eye level, her hands." },
    });
    expect(seamBreak(scene(), next)?.reason).toBe("shot_size_change");
  });

  it("still breaks on a named transition", () => {
    const next = scene({ sceneNumber: 2, transitionIn: "Cut to" });
    expect(seamBreak(scene(), next)?.reason).toBe("transition");
  });
});

describe("telling the agents how an arrival is written", () => {
  const continuous = { segmentSeconds: 20, sceneContinuity: "reuse_end_frame" } as Project;

  it("says nobody appears between segments", () => {
    const directive = seamDirective(continuous);
    expect(directive).toMatch(/Nobody appears between segments/);
    expect(directive).toMatch(/they arrive during it/);
    expect(directive).toMatch(/Write the start frame without them/);
  });

  it("says nothing for a project that cuts", () => {
    expect(seamDirective({ ...continuous, sceneContinuity: "cut" } as Project)).toBe("");
  });
});
