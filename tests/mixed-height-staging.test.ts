import { describe, it, expect } from "vitest";
import { mixesStandingAndSeated } from "@/lib/agents/media-prompt-normalise";

/**
 * Measured on one scene, holding the seed and changing one thing at a time: a
 * standing man behind a seated pair came back cropped at the neck; a lower
 * camera did not fix it, a wider shot did not fix it, and seating him did on the
 * first attempt.
 */
describe("a frame that mixes people on their feet with people off them", () => {
  it("flags a standing figure among seated ones", () => {
    expect(
      mixesStandingAndSeated(
        "Medium wide shot, eye level. He is seated in a corner chair. In the background a" +
          " tall man stands beside the bed.",
      ),
    ).toBe(true);
  });

  it("says nothing when everyone is seated", () => {
    expect(
      mixesStandingAndSeated(
        "Medium wide shot, eye level. He is seated in a corner chair. A tall man sits on the" +
          " edge of the bed beside her.",
      ),
    ).toBe(false);
  });

  it("says nothing when everyone is on their feet", () => {
    expect(
      mixesStandingAndSeated(
        "Wide shot, eye level. She walks across the suite as he approaches the window.",
      ),
    ).toBe(false);
  });

  it("covers kneeling and lying, not just sitting", () => {
    const upright = "Medium shot, eye level. She stands over him.";
    expect(mixesStandingAndSeated(`${upright} He kneels on the rug.`)).toBe(true);
    expect(mixesStandingAndSeated(`${upright} He lies back on the bed.`)).toBe(true);
  });

  /**
   * The appended cast sheet describes people, not staging, and its wording is
   * not the author's — a wardrobe clause mentioning a seat would fire on every
   * prompt in the project.
   */
  it("reads the scene body, not the appended cast sheet", () => {
    expect(
      mixesStandingAndSeated(
        "Wide shot, eye level. Two women walk toward the pier. Character continuity — Ana:" +
          " a woman seated at a loom in her portrait.",
      ),
    ).toBe(false);
  });

  /** Warning about a shot that already took the advice only teaches people to ignore it. */
  it("leaves a shot already framed wide alone", () => {
    const staging = "She walks in from the kitchen while he sits at the dining table.";
    expect(mixesStandingAndSeated(`Medium shot, eye level. ${staging}`)).toBe(true);
    expect(mixesStandingAndSeated(`Wide shot, eye level. ${staging}`)).toBe(false);
    expect(mixesStandingAndSeated(`Full shot, eye level. ${staging}`)).toBe(false);
  });
});
