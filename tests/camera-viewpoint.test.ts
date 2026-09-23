import { describe, it, expect } from "vitest";
import { focalSide, sideVisibleIn, viewpointOf } from "@/lib/media/viewpoint";import { gateImagePrompt, gateRepairDirective, repairImagePrompt } from "@/lib/agents/prompt-gate";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * The camera axis nobody was naming.
 *
 * Shot size, lens, camera height and movement were all specified per scene, and
 * all of them describe how high the camera is or how much of the frame it
 * fills. Nothing said where it stood *around* the subject, which is the axis
 * that decides whether a given side of a body faces the lens.
 *
 * Live, on a scene whose entire content was a man's hand gripping a woman's
 * backside: the prompt named the anatomy, the contact and the position, passed
 * every check, and opened "Medium close-up, eye level" with the pair staged
 * facing each other. Both bodies were side-on with her backside away from the
 * lens, and the render put his hand on her hip — the only place it could put a
 * hand it could see. Another scene in the same project opened "Medium
 * close-up, low angle" on a frame about her exposed backside; low angle is
 * height again, and says nothing about which side.
 */

/** The prompt that shipped, and produced a hand on a hip. */
const SHIPPED =
  "Medium close-up, eye level. Leroy, a Black man in a dark button-down shirt and dark " +
  "trousers, stands on the left side of the frame facing right toward TLBr3f, his body angled " +
  "slightly forward with his right hand sliding down to firmly grip her ass over the floral " +
  "fabric, his fingers curling into the thin cotton as he holds the position steady. TLBr3f, a " +
  "middle-aged blonde woman in a floral sundress, stands on the right side of the frame facing " +
  "left toward Leroy, swaying unsteadily with her eyes unfocused.";

/** The hand-written replacement that rendered correctly. */
const CORRECTED =
  "Medium close-up, eye level, bar interior, blue LED strip. Two people only. Leroy, Black man, " +
  "dark button-down, stands on the left facing her. His right arm wraps around her hip to the " +
  "back of her sundress. Palm flat on her ass over the floral cotton. Not on her stomach. Not " +
  "on her hip bone. TLBr3f, middle-aged blonde, floral sundress. She is turned three-quarters " +
  "so her ass is visible on the right of frame. Left hand weakly on his wrist.";

const ACTION =
  "Leroy's right hand slides down from TLBr3f's waist, his fingers curling into the fabric of " +
  "her floral sundress as he grips her ass firmly over the cotton. She swats weakly at his " +
  "wrist with her left hand but lacks the force to push him away.";

function scene(actionDescription: string): SceneDraft {
  return {
    id: "s1",
    projectId: "p",
    sceneNumber: 1,
    title: "The Grip",
    visualDescription: "A bar.",
    actionDescription,
    cameraMovement: "static",
  } as unknown as SceneDraft;
}

describe("reading the camera angle out of a prompt", () => {
  it("tells the horizontal positions apart", () => {
    expect(viewpointOf("Medium shot, from behind her, eye level")).toBe("rear");
    expect(viewpointOf("Medium shot, three-quarter, eye level")).toBe("three_quarter_front");
    expect(viewpointOf("Close-up in profile, low angle")).toBe("profile");
    expect(viewpointOf("Over-the-shoulder medium close-up")).toBe("over_shoulder");
    expect(viewpointOf("Wide shot, facing the camera")).toBe("front");
  });

  /** "Low angle" and "eye level" are the other axis and must not be read as one. */
  it("does not mistake camera height for camera angle", () => {
    expect(viewpointOf("Medium close-up, low angle.")).toBeUndefined();
    expect(viewpointOf("Medium close-up, eye level.")).toBeUndefined();
    expect(viewpointOf("Wide shot, high angle.")).toBeUndefined();
  });

  /**
   * Set dressing is not a camera position. Live, "blue LED light from the
   * back-bar behind them" read as a rear camera and passed a frame shot from
   * the front, so the angle is taken from the opening where the shot is
   * declared — the same window the shot size uses.
   */
  it("does not read a lamp standing behind someone as a camera behind them", () => {
    const prompt =
      "Medium close-up, eye level. Leroy stands on the left of frame facing right toward her, " +
      "his right hand gripping her ass over the floral fabric. The bare floorboards are " +
      "illuminated by hard electric blue LED light from the back-bar behind them.";

    expect(viewpointOf(prompt)).toBeUndefined();
    expect(sideVisibleIn(prompt, "rear")).toBe(false);
  });

  /** A camera named outright cannot be confused with a lamp, wherever it sits. */
  it("still reads an explicit camera placement later in the prompt", () => {
    expect(
      sideVisibleIn(
        "Medium close-up, eye level. She stands on the right. The camera is behind her.",
        "rear",
      ),
    ).toBe(true);
  });

  it("reads a three-quarter rear as rear rather than as three-quarter", () => {
    expect(viewpointOf("Medium shot, three-quarter rear, eye level")).toBe("three_quarter_rear");
  });
});

describe("whether the camera can see what the frame is about", () => {
  it("takes the focal side from the scene card, not the prompt", () => {
    expect(focalSide(ACTION)).toBe("rear");
    expect(focalSide("She walks across the bar and sets her glass down.")).toBeUndefined();
  });

  /**
   * One body's front against another's back is plainly visible from behind, so
   * the mirror rule fired on six correct frames in a real project — including a
   * doggy-style frame that named a penis and a vagina from a rear camera.
   */
  it("has no opinion about front anatomy, where two bodies make it ambiguous", () => {
    expect(
      focalSide("Leroy's erect cock is fully inserted in TLBr3f's pussy from behind."),
    ).toBeUndefined();
  });

  it("stays quiet when both sides are named", () => {
    expect(focalSide("His palm is flat on her ass, not on her stomach.")).toBeUndefined();
  });

  it("accepts a camera angle that can see the back of a body", () => {
    expect(sideVisibleIn("Medium close-up, from behind her.", "rear")).toBe(true);
    expect(sideVisibleIn("Medium close-up, three-quarter.", "rear")).toBe(true);
    expect(sideVisibleIn("Medium close-up, in profile.", "rear")).toBe(true);
  });

  it("rejects one that cannot", () => {
    expect(sideVisibleIn("Medium close-up, eye level, facing the camera.", "rear")).toBe(false);
    expect(sideVisibleIn("Medium close-up, low angle.", "rear")).toBe(false);
  });

  /** The natural way to write it is to turn the body, not to name an angle. */
  it("accepts a body turned to present the part instead of a named angle", () => {
    expect(
      sideVisibleIn("She is turned three-quarters so her ass is visible on the right.", "rear"),
    ).toBe(true);
    expect(sideVisibleIn("Her bare backside is presented to the camera.", "rear")).toBe(true);
  });
});

describe("the gate, on the frame that shipped", () => {
  it("rejects the prompt that put the hand on a hip", () => {
    const codes = gateImagePrompt(SHIPPED, "end", {
      scene: scene(ACTION),
      participants: [],
      explicit: false,
    });
    expect(codes).toContain("focal_point_hidden");
  });

  it("accepts the hand-written replacement", () => {
    const codes = gateImagePrompt(CORRECTED, "end", {
      scene: scene(ACTION),
      participants: [],
      explicit: false,
    });
    expect(codes).not.toContain("focal_point_hidden");
  });

  /** Camera height was the only axis the shipped prompt named. */
  it("rejects a low angle on a frame about a backside", () => {
    const action =
      "Leroy lifts the hem of her sundress, exposing her bare backside and thighs to the light.";
    const prompt =
      "Medium close-up, low angle. Leroy's left hand grips the hem of the floral sundress, " +
      "bunching the cotton in his fist as he lifts it high to expose her bare backside and " +
      "upper thighs to the hard blue LED light.";

    const codes = gateImagePrompt(prompt, "end", {
      scene: scene(action),
      participants: [],
      explicit: false,
    });
    expect(codes).toContain("focal_point_hidden");
  });

  it("says nothing about a scene with no focal point to miss", () => {
    const action = "She walks across the bar and sets her glass down on the brass rail.";
    const prompt =
      "Wide shot, eye level. A woman in a floral sundress crosses the bare floorboards of a " +
      "dim bar and sets a short glass down on the brass rail, her hand still resting on it.";

    const codes = gateImagePrompt(prompt, "end", {
      scene: scene(action),
      participants: [],
      explicit: false,
    });
    expect(codes).not.toContain("focal_point_hidden");
  });

  it("tells the retry to name the angle and turn the body", () => {
    const directive = gateRepairDirective(["focal_point_hidden"], {
      scene: scene(ACTION),
      participants: [],
      explicit: false,
    });
    expect(directive).toContain("where the camera stands around the subject");
    expect(directive).toContain("a hand on a backside becomes a hand on a hip");
  });

  /** When the retry fails too, the camera still has to end up somewhere useful. */
  it("puts the camera behind the subject as a last resort, and the repair passes", () => {
    const ctx = { scene: scene(ACTION), participants: [], explicit: false };
    const repaired = repairImagePrompt(SHIPPED, "end", ["focal_point_hidden"], ctx);

    expect(repaired).toContain("three-quarters behind the subject");
    expect(gateImagePrompt(repaired, "end", ctx)).not.toContain("focal_point_hidden");
  });
});
