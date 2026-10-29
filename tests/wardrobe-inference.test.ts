import { describe, expect, it } from "vitest";
import {
  foldWardrobeChanges,
  inferUndressChanges,
  wardrobeContradictions,
  wardrobeTimeline,
} from "@/lib/agents/wardrobe";
import { castPromptSuffix } from "@/lib/agents/cast";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * The storyboard model restated the opening outfit on scenes 1-4 and never
 * recorded the undressing, so the timeline said "lingerie" to the end while the
 * cards read "nude" from scene 11 on, and prompts carried both.
 */

const TLB: Character = {
  id: "c-1",
  name: "TLBr3f",
  description: "a middle-aged blonde woman with blue eyes",
  wardrobe: "matching black lace bra and panties",
} as Character;
const MAN: Character = {
  id: "c-2",
  name: "Daniel",
  description: "a tall man",
  wardrobe: "a grey suit",
} as Character;

const project = (wardrobeChanges: Project["wardrobeChanges"] = {}): Project =>
  ({ id: "p", wardrobeChanges, characterWardrobe: {} }) as Project;

function scene(n: number, over: Partial<SceneDraft> = {}) {
  return {
    id: `p-scene-${String(n).padStart(3, "0")}`,
    sceneNumber: n,
    title: `Segment ${n}`,
    sceneObjective: "",
    visualDescription: "A club stage.",
    actionDescription: "TLBr3f spins around the pole.",
    storyBeat: "She dances.",
    charactersPresent: ["TLBr3f"],
    ...over,
  } as Pick<
    SceneDraft,
    | "id" | "sceneNumber" | "title" | "sceneObjective" | "visualDescription" | "actionDescription"
    | "storyBeat" | "dialogue" | "continuityNotes" | "charactersPresent"
  >;
}

const nude = (n: number) =>
  scene(n, { actionDescription: "TLBr3f rises into a Carousel Spin, her nude body displayed." });

describe("inferring the undressing the storyboard left out", () => {
  const scenes = [scene(1), scene(2), scene(3), nude(4), scene(5), nude(6)];

  it("marks the first scene that states nudity, and the timeline carries it forward", () => {
    const inferred = inferUndressChanges(project(), scenes, [TLB]);
    expect(inferred.wardrobeChanges).toEqual({
      "p-scene-004": [{ characterId: "c-1", wardrobe: "nude", mode: "between", origin: "story" }],
    });
    const timeline = wardrobeTimeline(inferred, scenes, [TLB]);
    expect(timeline.get("p-scene-003")!.end["c-1"]).toBe("matching black lace bra and panties");
    expect(timeline.get("p-scene-004")!.start["c-1"]).toBe("nude");
    expect(timeline.get("p-scene-005")!.start["c-1"]).toBe("nude");
  });

  it("leaves the contradiction check nothing to flag afterwards", () => {
    const before = wardrobeContradictions(project(), scenes, [TLB]);
    expect(before.map((s) => s.sceneNumber)).toContain(6);
    const after = wardrobeContradictions(inferUndressChanges(project(), scenes, [TLB]), scenes, [TLB]);
    expect(after).toEqual([]);
  });

  it("does nothing when nobody is dressed or there is no cast", () => {
    expect(inferUndressChanges(project(), scenes, [])).toEqual(project());
    const already = project({ "p-scene-002": [{ characterId: "c-1", wardrobe: "nude", mode: "between" }] });
    expect(inferUndressChanges(already, scenes, [TLB])).toBe(already);
  });

  it("never overwrites a change on the scene, whoever made it", () => {
    const robed = project({
      "p-scene-004": [{ characterId: "c-1", wardrobe: "a hotel robe", mode: "within", origin: "story" }],
    });
    const result = inferUndressChanges(robed, scenes, [TLB]);
    expect(result.wardrobeChanges?.["p-scene-004"]).toEqual(robed.wardrobeChanges!["p-scene-004"]);
  });

  it("will not guess who is bare when two pinned characters are in the scene", () => {
    const crowded = [scene(1), nude(2)].map((s) => ({ ...s, charactersPresent: ["TLBr3f", "Daniel"] }));
    expect(inferUndressChanges(project(), crowded, [TLB, MAN]).wardrobeChanges).toEqual({});
  });

  it("ignores sex-act vocabulary that does not say anyone is unclothed", () => {
    const climax = [
      scene(1, { actionDescription: "TLBr3f reaches the climax of her routine, thrusting her hips." }),
    ];
    expect(inferUndressChanges(project(), climax, [TLB]).wardrobeChanges).toEqual({});
  });

  it("is rebuilt from the new cards when the storyboard is regenerated", () => {
    const first = inferUndressChanges(project(), scenes, [TLB]);
    const clothed = [scene(1), scene(2), scene(3), scene(4)];
    const refolded = foldWardrobeChanges(
      first, clothed.map((s) => ({ id: s.id, wardrobeChanges: [] })), [TLB],
    );
    expect(refolded.wardrobeChanges?.["p-scene-004"]).toBeUndefined();
    expect(inferUndressChanges(refolded, clothed, [TLB]).wardrobeChanges).toEqual({});
  });
});

describe("a model that restates the outfit it was already given", () => {
  const draft = (id: string, wardrobe: string) => ({
    id,
    wardrobeChanges: [{ character: "TLBr3f", newWardrobe: wardrobe, depictedOnScreen: false }],
  });

  it("is not recorded as a change, while a real difference still is", () => {
    const folded = foldWardrobeChanges(
      project(),
      [
        draft("p-scene-001", "matching black lace bra and panties with silver buckle garter"),
        draft("p-scene-002", "Matching black lace bra and panties with silver buckle garter."),
        draft("p-scene-003", "matching black lace bra and panties with silver buckle garter"),
        draft("p-scene-004", "a hotel robe"),
      ],
      [TLB],
    );
    expect(Object.keys(folded.wardrobeChanges ?? {}).sort()).toEqual(["p-scene-001", "p-scene-004"]);
  });

  it("does not record the pinned outfit as a change either", () => {
    const folded = foldWardrobeChanges(
      project(), [draft("p-scene-001", "Matching black lace bra and panties")], [TLB],
    );
    expect(folded.wardrobeChanges).toEqual({});
  });
});

describe("the cast sheet and a prompt that says the character is naked", () => {
  const frame = { faceVisible: true, tightShot: false };
  const dressed = { "c-1": "matching black lace bra and panties" };

  it("states her as naked rather than dressed when the prompt body says so", () => {
    const suffix = castPromptSuffix(
      [TLB], dressed, frame,
      "Medium wide shot. She is fully naked save for a single garter, gripping the pole.",
    );
    expect(suffix).toContain("completely naked");
    expect(suffix).not.toContain("black lace");
  });

  it("leaves a dressed character dressed when the body does not say otherwise", () => {
    const suffix = castPromptSuffix([TLB], dressed, frame, "Medium shot. She grips the pole.");
    expect(suffix).toContain("black lace bra and panties");
  });

  it("only undresses the person the nudity sentence names", () => {
    const suffix = castPromptSuffix(
      [TLB, MAN],
      { "c-1": "black lace lingerie", "c-2": "a grey suit" },
      frame,
      "Wide shot. TLBr3f is naked beside the pole. Daniel stands at the bar.",
    );
    expect(suffix).toContain("completely naked");
    expect(suffix).toContain("grey suit");
    expect(suffix).not.toContain("black lace lingerie");
  });
});
