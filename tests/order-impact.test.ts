import { describe, it, expect } from "vitest";
import { orderImpact } from "@/lib/storyboard/order-impact";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";

/**
 * What a reorder costs, reported rather than repaired.
 *
 * Every case here is about honesty in one direction or the other: a
 * consequence that is real must be named, and one that is not must be silent.
 * A dialog that warns unconditionally teaches people to dismiss it.
 */

function scene(n: number, overrides: Partial<Scene> = {}): Scene {
  return {
    id: `s${n}`,
    projectId: "p1",
    sceneNumber: n,
    startTimeSeconds: (n - 1) * 20,
    endTimeSeconds: n * 20,
    targetDurationSeconds: 20,
    title: `Scene ${n}`,
    sceneObjective: "o",
    storyBeat: "b",
    visualDescription: "v",
    actionDescription: "a",
    cameraMovement: "Static wide shot",
    // Continuous rather than "Cut": under `reuse_end_frame` a named transition
    // is itself a declared seam break, so a fixture full of cuts would report
    // no seam consequences at all and prove nothing.
    transitionIn: "Continuous action",
    transitionOut: "Continuous action",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    status: "planned",
    prompts: {
      startFramePrompt: `start ${n}`,
      endFramePrompt: `end ${n}`,
      videoPromptSegment: `video ${n}`,
      videoNegativePrompt: "",
      imageNegativePrompt: "",
      promptQualityChecklist: [],
    },
    ...overrides,
  } as Scene;
}

function record(project: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    project: {
      id: "p1",
      segmentSeconds: 20,
      segmentCount: 4,
      finalTrimSeconds: 0,
      generatedDurationSeconds: 80,
      requestedDurationSeconds: 80,
      sceneContinuity: "reuse_end_frame",
      ...project,
    },
    storyboard: { projectId: "p1", scenes: [scene(1), scene(2), scene(3), scene(4)] },
    ...rest,
  } as unknown as ProjectRecord;
}

const noCast: Character[] = [];

describe("continuity seams", () => {
  it("names the scenes whose predecessor changed", () => {
    const impact = orderImpact(record(), ["s1", "s3", "s2", "s4"], noCast);
    // s3 now follows s1; s2 now follows s3; s4 now follows s2.
    expect(impact.promptSeams.map((s) => s.id).sort()).toEqual(["s2", "s3", "s4"]);
  });

  it("says nothing about a scene whose predecessor is unchanged", () => {
    const impact = orderImpact(record(), ["s1", "s2", "s4", "s3"], noCast);
    expect(impact.promptSeams.map((s) => s.id)).not.toContain("s2");
  });

  /** Under `cut` nothing inherits, so no seam can go stale. */
  it("reports no seam at all on a cut project", () => {
    const impact = orderImpact(
      record({ sceneContinuity: "cut" }),
      ["s4", "s3", "s2", "s1"],
      noCast,
    );
    expect(impact.promptSeams).toEqual([]);
    expect(impact.inheritedFrames).toEqual([]);
    expect(impact.clean).toBe(true);
  });

  /** A scene that declares its own break was never matched to a neighbour. */
  it("skips a scene that opens on a declared cut, wherever it lands", () => {
    const scenes = [scene(1), scene(2), scene(3, { transitionIn: "Cut to" }), scene(4)];
    const base = record();
    const withBreak = {
      ...base,
      storyboard: { ...base.storyboard!, scenes },
    } as ProjectRecord;

    // Moved into the middle, so it has a predecessor in both orders.
    const impact = orderImpact(withBreak, ["s1", "s3", "s2", "s4"], noCast);
    expect(impact.promptSeams.map((s) => s.id)).not.toContain("s3");
    // Its neighbours are still affected; only its own opening is exempt.
    expect(impact.promptSeams.map((s) => s.id)).toContain("s2");
  });

  /** Opening the piece is a real change to a scene that used to continue one. */
  it("reports a scene that has become the first", () => {
    const impact = orderImpact(record(), ["s3", "s1", "s2", "s4"], noCast);
    expect(impact.promptSeams.map((s) => s.id)).toContain("s3");
  });

  it("reports a carried frame only where one was actually rendered", () => {
    const withFrames = record({}, {
      attempts: {
        s3: [{ id: "a3", sceneId: "s3", attemptNumber: 1, startImageInherited: true }],
        s4: [{ id: "a4", sceneId: "s4", attemptNumber: 1 }],
      },
    });

    const impact = orderImpact(withFrames, ["s1", "s3", "s2", "s4"], noCast);
    expect(impact.inheritedFrames.map((s) => s.id)).toEqual(["s3"]);
    // s4's seam still moved, it just has no inherited frame to invalidate.
    expect(impact.promptSeams.map((s) => s.id)).toContain("s4");
  });

  it("numbers the affected scenes as they will appear afterwards", () => {
    const impact = orderImpact(record(), ["s4", "s1", "s2", "s3"], noCast);
    const moved = impact.promptSeams.find((s) => s.id === "s1");
    expect(moved?.sceneNumber).toBe(2);
    expect(moved?.title).toBe("Scene 1");
  });
});

describe("wardrobe", () => {
  const cast = [{ id: "c1", name: "Juan" }] as unknown as Character[];

  it("reports a scene whose outfit resolves differently after the move", () => {
    // The change fires in scene 3, so scenes 3 and 4 wear the new outfit.
    const withChange = record({
      wardrobeChanges: {
        s3: [{ characterId: "c1", wardrobe: "a red coat", mode: "between" }],
      },
    });

    // Moving scene 4 above scene 3 puts it before the change.
    const impact = orderImpact(withChange, ["s1", "s2", "s4", "s3"], cast);
    expect(impact.wardrobe.map((s) => s.id)).toContain("s4");
  });

  it("says nothing when the move crosses no costume change", () => {
    const impact = orderImpact(record(), ["s2", "s1", "s3", "s4"], cast);
    expect(impact.wardrobe).toEqual([]);
  });
});

describe("stale artifacts", () => {
  it("reports a stored assembly, audio plan and animatic", () => {
    const withArtifacts = record({}, {
      assembly: { plan: { projectId: "p1", clips: [] } },
      audioPlan: { projectId: "p1", cues: [] },
      animaticPlan: { projectId: "p1" },
    });

    const impact = orderImpact(withArtifacts, ["s2", "s1", "s3", "s4"], noCast);
    expect(impact.staleArtifacts).toEqual(["assembly", "audioPlan", "animaticPlan"]);
    expect(impact.clean).toBe(false);
  });

  it("reports none when the project has no stored artifacts", () => {
    const impact = orderImpact(record({ sceneContinuity: "cut" }), ["s2", "s1", "s3", "s4"], noCast);
    expect(impact.staleArtifacts).toEqual([]);
  });
});

describe("an insertion", () => {
  /** A scene that does not exist yet has no history to invalidate. */
  it("assesses the order without the new scene being in the record", () => {
    const impact = orderImpact(record(), ["s1", "s2", "new", "s3", "s4"], noCast);
    expect(impact.promptSeams.map((s) => s.id)).toEqual(["s3"]);
    expect(impact.promptSeams.every((s) => s.id !== "new")).toBe(true);
  });
});

describe("a storyboard that does not exist", () => {
  it("is clean rather than an error", () => {
    const impact = orderImpact({ project: { id: "p1" } } as ProjectRecord, [], noCast);
    expect(impact.clean).toBe(true);
  });
});
