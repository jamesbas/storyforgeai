import { describe, it, expect } from "vitest";
import {
  applyRunningOrder,
  insertInOrder,
  moveInOrder,
  remapNumberKeys,
  renumberingFrom,
  withRunningOrder,
} from "@/lib/storyboard/running-order";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

/**
 * The running-order core.
 *
 * Reordering a storyboard is safe only because scene id is the primary key and
 * position is derived. These cases are the proof of that: ids never change,
 * nothing keyed by them is touched, and everything derived from position is
 * rebuilt rather than patched.
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
    transitionIn: "Cut",
    transitionOut: "Cut",
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

const timing = { segmentSeconds: 20, finalTrimSeconds: 0 };

describe("choosing a new order", () => {
  it("moves a scene up and down by one", () => {
    const ids = ["s1", "s2", "s3", "s4"];
    expect(moveInOrder(ids, "s3", "up")).toEqual(["s1", "s3", "s2", "s4"]);
    expect(moveInOrder(ids, "s3", "down")).toEqual(["s1", "s2", "s4", "s3"]);
  });

  /** A dead button must be refused, not silently succeed. */
  it("refuses to move past either end", () => {
    const ids = ["s1", "s2", "s3"];
    expect(moveInOrder(ids, "s1", "up")).toBeNull();
    expect(moveInOrder(ids, "s3", "down")).toBeNull();
    expect(moveInOrder(ids, "nope", "up")).toBeNull();
  });

  it("leaves the order it was given untouched", () => {
    const ids = ["s1", "s2", "s3"];
    moveInOrder(ids, "s2", "down");
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  /** The FR-U6 guarantee: two labels, one gap. */
  it("puts an insert after N and before N+1 in the same place", () => {
    const ids = ["s1", "s2", "s3"];
    expect(insertInOrder(ids, "new", "s2", "after")).toEqual(
      insertInOrder(ids, "new", "s3", "before"),
    );
    expect(insertInOrder(ids, "new", "s2", "after")).toEqual(["s1", "s2", "new", "s3"]);
  });

  it("prepends before the first and appends after the last", () => {
    const ids = ["s1", "s2"];
    expect(insertInOrder(ids, "new", "s1", "before")).toEqual(["new", "s1", "s2"]);
    expect(insertInOrder(ids, "new", "s2", "after")).toEqual(["s1", "s2", "new"]);
  });
});

describe("applying an order", () => {
  it("renumbers contiguously from one", () => {
    const scenes = [scene(1), scene(2), scene(3)];
    const applied = applyRunningOrder(scenes, ["s3", "s1", "s2"], timing);
    expect(applied.map((s) => s.sceneNumber)).toEqual([1, 2, 3]);
    expect(applied.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
  });

  it("never changes a scene id", () => {
    const scenes = [scene(1), scene(2), scene(3)];
    const applied = applyRunningOrder(scenes, ["s2", "s3", "s1"], timing);
    expect(new Set(applied.map((s) => s.id))).toEqual(new Set(["s1", "s2", "s3"]));
  });

  it("keeps the timeline contiguous", () => {
    const applied = applyRunningOrder([scene(1), scene(2), scene(3)], ["s3", "s2", "s1"], timing);
    expect(applied.map((s) => [s.startTimeSeconds, s.endTimeSeconds])).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
    ]);
  });

  it("carries the creative content with the scene, not the position", () => {
    const applied = applyRunningOrder([scene(1), scene(2)], ["s2", "s1"], timing);
    expect(applied[0]!.title).toBe("Scene 2");
    expect(applied[0]!.prompts.startFramePrompt).toBe("start 2");
    expect(applied[0]!.sceneNumber).toBe(1);
  });

  /** The trim belongs to the last position, not to the scene that was there. */
  it("moves the end trim to whatever is last now", () => {
    const scenes = [scene(1), scene(2), scene(3, { trimAtEndSeconds: 14 })];
    const applied = applyRunningOrder(scenes, ["s3", "s1", "s2"], {
      segmentSeconds: 20,
      finalTrimSeconds: 6,
    });
    expect(applied[0]!.trimAtEndSeconds).toBeUndefined();
    expect(applied[2]!.trimAtEndSeconds).toBe(14);
  });

  it("leaves no trim at all when the project asks for none", () => {
    const scenes = [scene(1), scene(2, { trimAtEndSeconds: 14 })];
    const applied = applyRunningOrder(scenes, ["s2", "s1"], timing);
    expect(applied.every((s) => s.trimAtEndSeconds === undefined)).toBe(true);
  });

  it("refuses an order that is not a permutation of the scenes", () => {
    const scenes = [scene(1), scene(2)];
    expect(() => applyRunningOrder(scenes, ["s1"], timing)).toThrow(/1 entries/);
    expect(() => applyRunningOrder(scenes, ["s1", "s9"], timing)).toThrow(/unknown scene/);
    expect(() => applyRunningOrder(scenes, ["s1", "s1"], timing)).toThrow(/twice/);
  });
});

describe("remapping number-keyed plans", () => {
  it("follows a scene to its new number", () => {
    const renumbering = renumberingFrom(["s1", "s2", "s3"], ["s3", "s1", "s2"]);
    const remapped = remapNumberKeys({ "1": "a", "2": "b", "3": "c" }, renumbering);
    // s1 was 1 and is now 2; s2 was 2 and is now 3; s3 was 3 and is now 1.
    expect(remapped).toEqual({ "2": "a", "3": "b", "1": "c" });
  });

  /**
   * The failure this whole design guards against: a swap is a permutation, and
   * rewriting the keys one at a time collapses both onto the second write.
   */
  it("does not collapse a straight swap", () => {
    const renumbering = renumberingFrom(["a", "b", "c", "d", "e"], ["a", "b", "c", "e", "d"]);
    const remapped = remapNumberKeys(
      { "1": "one", "2": "two", "3": "three", "4": "four", "5": "five" },
      renumbering,
    );
    expect(remapped).toEqual({
      "1": "one",
      "2": "two",
      "3": "three",
      "5": "four",
      "4": "five",
    });
    expect(Object.keys(remapped)).toHaveLength(5);
  });

  it("keeps whichever key shape the model wrote", () => {
    const renumbering = renumberingFrom(["s1", "s2"], ["s2", "s1"]);
    expect(remapNumberKeys({ "scene 1": "a", "Scene 2": "b" }, renumbering)).toEqual({
      "scene 2": "a",
      "Scene 1": "b",
    });
  });

  it("leaves id keys alone, because they already name the right scene", () => {
    const renumbering = renumberingFrom(["s1", "s2"], ["s2", "s1"]);
    expect(remapNumberKeys({ s1: "a", s2: "b" }, renumbering)).toEqual({ s1: "a", s2: "b" });
  });

  it("leaves keys that resolve to nothing alone", () => {
    const renumbering = renumberingFrom(["s1", "s2"], ["s2", "s1"]);
    expect(remapNumberKeys({ "99": "a", notes: "b" }, renumbering)).toEqual({
      "99": "a",
      notes: "b",
    });
  });

  it("returns the original map when nothing moved", () => {
    const renumbering = renumberingFrom(["s1", "s2"], ["s1", "s2"]);
    const map = { "1": "a", "2": "b" };
    expect(remapNumberKeys(map, renumbering)).toBe(map);
  });

  /** An inserted scene has no entry, and one must not be invented for it. */
  it("shifts around an insertion without inventing an entry", () => {
    const renumbering = renumberingFrom(["s1", "s2"], ["s1", "new", "s2"]);
    expect(remapNumberKeys({ "1": "a", "2": "b" }, renumbering)).toEqual({ "1": "a", "3": "b" });
  });
});

describe("putting a record into a new order", () => {
  function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    return {
      project: {
        id: "p1",
        segmentSeconds: 20,
        segmentCount: 3,
        finalTrimSeconds: 0,
        generatedDurationSeconds: 60,
        requestedDurationSeconds: 60,
      },
      storyboard: { projectId: "p1", scenes: [scene(1), scene(2), scene(3)] },
      ...overrides,
    } as unknown as ProjectRecord;
  }

  it("reorders and renumbers the storyboard", () => {
    const next = withRunningOrder(record(), ["s2", "s3", "s1"]);
    expect(next.storyboard!.scenes.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect(next.storyboard!.scenes.map((s) => s.sceneNumber)).toEqual([1, 2, 3]);
  });

  /**
   * The guarantee the whole feature rests on: everything expensive is keyed by
   * scene id, and a reorder must not so much as read it.
   */
  it("leaves every id-keyed structure byte-identical", () => {
    const attempts = { s1: [{ id: "a1" }], s3: [{ id: "a3" }] };
    const previews = { s2: { startImagePath: "/p.png" } };
    const before = record({
      attempts,
      previews,
      project: {
        id: "p1",
        segmentSeconds: 20,
        segmentCount: 3,
        finalTrimSeconds: 0,
        generatedDurationSeconds: 60,
        requestedDurationSeconds: 60,
        sceneSeeds: { s1: 11, s2: 22 },
        sceneLoras: { s1: { image: [], video: [] } },
        sceneEndFrameRefs: { s2: true },
        wardrobeChanges: { s3: [{ characterId: "c1", wardrobe: "red coat" }] },
      },
    } as unknown as Partial<ProjectRecord>);

    const after = withRunningOrder(before, ["s3", "s2", "s1"]);

    expect(after.attempts).toBe(before.attempts);
    expect(after.previews).toBe(before.previews);
    expect(after.project.sceneSeeds).toEqual(before.project.sceneSeeds);
    expect(after.project.sceneLoras).toEqual(before.project.sceneLoras);
    expect(after.project.sceneEndFrameRefs).toEqual(before.project.sceneEndFrameRefs);
    expect(after.project.wardrobeChanges).toEqual(before.project.wardrobeChanges);
  });

  it("remaps both number-keyed plans together", () => {
    const before = record({
      directorialPlan: { projectId: "p1", sceneIntent: { "1": "open", "3": "close" } },
      cinematographyPlan: { projectId: "p1", sceneShotPlans: { "1": "wide", "3": "tight" } },
    } as unknown as Partial<ProjectRecord>);

    const after = withRunningOrder(before, ["s3", "s1", "s2"]);

    // s1 moved 1 -> 2, s3 moved 3 -> 1.
    expect(after.directorialPlan!.sceneIntent).toEqual({ "2": "open", "1": "close" });
    expect(after.cinematographyPlan!.sceneShotPlans).toEqual({ "2": "wide", "1": "tight" });
  });

  it("does not invent plans a project never had", () => {
    const after = withRunningOrder(record(), ["s2", "s1", "s3"]);
    expect("directorialPlan" in after).toBe(false);
    expect("cinematographyPlan" in after).toBe(false);
  });

  it("refuses a project with no storyboard", () => {
    expect(() => withRunningOrder({ project: { id: "p1" } } as ProjectRecord, [])).toThrow(
      /storyboard is required/,
    );
  });
});
