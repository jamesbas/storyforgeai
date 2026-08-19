import { describe, it, expect } from "vitest";
import { gateImagePrompt, repairImagePrompt, withoutInventedGarments } from "@/lib/agents/prompt-gate";
import { minimumShotSizeFor, shotSizeOf, widenShotSize } from "@/lib/media/seam";
import { positiveConstraintClause, withActGuards } from "@/lib/agents/negative-prompt";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * A three-person frame asked for as a close-up.
 *
 * The shipped prompt for one scene's end frame, with the two faults that made
 * it fail: it opens "Close-Up" while naming three people at opposite ends of a
 * body, and it dresses a participant the act undresses. The render dropped the
 * second man entirely and put an unidentifiable object at the woman's mouth
 * where his cock should have been — which is what a model does when it is asked
 * for anatomy the frame has no room for.
 */
const SHIPPED =
  "Close-Up, eye level. Mara, a 52-year-old woman with honey-blonde wavy hair, lies sprawled " +
  "on her back against the rumpled sheets entirely nude. Intruder One, a heavy-set man in his " +
  "40s wearing dark grey cotton t-shirt and matching cargo trousers, presses his pelvis down " +
  "firmly against Mara's hips with cock (penis) fully inserted deep into her vagina. The second " +
  "man leans over Mara's head from the side, one hand braced on the mattress near her hip and " +
  "guiding his cock deeper into her mouth. Exactly three people are in frame: one woman nude, " +
  "two men clothed in dark grey garments.";

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "scene-7",
    projectId: "p1",
    sceneNumber: 7,
    startTimeSeconds: 0,
    endTimeSeconds: 8,
    targetDurationSeconds: 8,
    title: "Both of them",
    sceneObjective: "She is taken by both men at once.",
    storyBeat: "They take her together.",
    visualDescription: "Mara nude on the bed between two men.",
    actionDescription:
      "One man penetrates her vagina while the second guides his cock into her mouth.",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: ["Mara"],
    wardrobeChanges: [],
    status: "planned",
    ...overrides,
  } as SceneDraft;
}

const ctx = {
  scene: scene(),
  participants: ["Mara"],
  explicit: true,
  establishedWardrobe: { start: "", end: "" },
};

describe("a shot size that cannot hold the people in it", () => {
  it("leaves a close-up on one person alone", () => {
    expect(minimumShotSizeFor(1)).toBeUndefined();
  });

  it("widens as the frame fills", () => {
    expect(minimumShotSizeFor(2)).toBe("medium_close");
    expect(minimumShotSizeFor(3)).toBe("medium");
    expect(minimumShotSizeFor(5)).toBe("medium_wide");
  });

  it("rejects the close-up that dropped the second man", () => {
    expect(gateImagePrompt(SHIPPED, "end", ctx)).toContain("framing_too_tight");
  });

  /**
   * The count the prompt states, not the pinned cast. Only one of these three
   * is in the character library, so `participants` would have said one person
   * and passed the frame that failed.
   */
  it("counts everyone in shot, not just the cast", () => {
    expect(ctx.participants).toHaveLength(1);
    expect(gateImagePrompt(SHIPPED, "end", ctx)).toContain("framing_too_tight");
  });

  it("accepts the same three people at a medium shot", () => {
    const widened = SHIPPED.replace("Close-Up", "Medium shot");
    expect(gateImagePrompt(widened, "end", ctx)).not.toContain("framing_too_tight");
  });

  it("widens the prompt to the size the headcount needs", () => {
    const codes = gateImagePrompt(SHIPPED, "end", ctx);
    const repaired = repairImagePrompt(SHIPPED, "end", codes, ctx);
    expect(shotSizeOf(repaired)).toBe("medium");
    expect(repaired).toMatch(/^Medium shot, eye level\./);
  });

  /** Only the framing words change; the direction around them is not at fault. */
  it("keeps the camera height and everything after it", () => {
    const widened = widenShotSize("Extreme close-up, low angle, 35mm. She waits.", "medium_wide");
    expect(widened).toBe("Medium wide shot, low angle, 35mm. She waits.");
  });

  it("says nothing about a prompt that never states a size", () => {
    expect(widenShotSize("Mara waits by the door.", "medium")).toBe("Mara waits by the door.");
  });
});

describe("clothing on a body the act undresses", () => {
  it("takes the invented outfit off rather than arguing with it", () => {
    const stripped = withoutInventedGarments(SHIPPED, "");
    expect(stripped).not.toMatch(/t-shirt|trousers/i);
    expect(stripped).toContain("in his 40s naked, presses his pelvis");
  });

  /** The headcount sentence carried the same contradiction in its own words. */
  it("corrects a headcount that calls the participants clothed", () => {
    expect(withoutInventedGarments(SHIPPED, "")).toContain("one woman nude, two men naked.");
  });

  it("leaves an outfit this scene's wardrobe established exactly as written", () => {
    const dressed = "Mara, wearing a short black silk robe, stands by the window.";
    expect(withoutInventedGarments(dressed, "short black silk robe")).toBe(dressed);
  });

  it("leaves a clause that is not about clothing alone", () => {
    const worn = "She lies back wearing nothing but a smile.";
    expect(withoutInventedGarments(worn, "")).toBe(worn);
  });

  /**
   * The repair used to append "every participant is completely naked" and leave
   * the garment sentence standing, so one prompt asserted both.
   */
  it("no longer ships a prompt that contradicts itself", () => {
    const codes = gateImagePrompt(SHIPPED, "end", ctx);
    expect(codes).toContain("wardrobe_contradicts_act");
    const repaired = repairImagePrompt(SHIPPED, "end", codes, ctx);
    expect(repaired).toContain("completely naked");
    expect(repaired).not.toMatch(/t-shirt|trousers|clothed/i);
  });
});

describe("guards for a frame that depicts an act", () => {
  it("adds nothing to a frame that does not", () => {
    expect(withActGuards("blurry, watermark", false)).toBe("blurry, watermark");
  });

  it("names the substitutions a model reaches for when it cannot draw the act", () => {
    const guarded = withActGuards("blurry", true);
    expect(guarded).toContain("stray objects");
    expect(guarded).toContain("detached body parts");
    expect(guarded).toContain("obscured genitals");
  });

  /**
   * Distinct from a detached limb: the part is attached, in the wrong place. A
   * live frame reading "his cock (penis) positioned at her mouth" rendered a
   * penis growing from the man's own face, which "every limb joined to the body
   * it belongs to" neither describes nor forbids.
   */
  it("guards a part attached in the wrong place, not just a loose one", () => {
    expect(withActGuards("blurry", true)).toContain("misplaced anatomy");
    expect(positiveConstraintClause(withActGuards("", true), 3)).toContain(
      "genitals at the groin, mouths on faces",
    );
  });

  it("does not repeat a term the prompt already excluded", () => {
    const guarded = withActGuards("stray objects, blurry", true);
    expect(guarded.match(/stray objects/g)).toHaveLength(1);
  });

  /**
   * Krea and FLUX discard a negative prompt, so every guard has to survive the
   * fold as something a sampler can construct. Spelled out as an absence these
   * would name the very artifacts they exist to prevent.
   */
  it("folds into what to render instead, never into an absence", () => {
    const folded = positiveConstraintClause(withActGuards("", true), 3);
    expect(folded).toContain("only bare skin and flesh at every point of contact");
    expect(folded).toContain("every limb joined to the body it belongs to");
    expect(folded).toContain("fully visible and unobstructed");
    expect(folded).not.toContain("The frame is free of");
  });
});
