import { describe, it, expect } from "vitest";
import { swapTargetClause } from "@/lib/services/face-swap-service";

/**
 * Telling the swap which head to take.
 *
 * A character's swap prompt is a template meant to serve every scene they ever
 * appear in, so it names its target generically — "the white woman". That is
 * accurate and ambiguous at the same time: in a shot where the other man wore a
 * white polo and faced the camera while she lay in profile, the pass took his
 * head and gave him her face.
 */

const MARA = {
  wardrobe: "nude",
  description: "A 52-year-old woman with honey-blonde shoulder-length wavy hair.",
};
const DANE = {
  wardrobe: "blue jeans and a white polo shirt",
  description: "A man in his fifties with dark brown hair.",
};
const STRANGER = { wardrobe: "nude", description: "the muscular Black man" };

describe("naming the head a swap should replace", () => {
  it("says nothing on a frame holding one person", () => {
    expect(swapTargetClause(MARA, [])).toBe("");
  });

  /** Wardrobe settles it in almost every case, and is already on the timeline. */
  it("separates a clothed person by what they are wearing", () => {
    const clause = swapTargetClause(DANE, [MARA, STRANGER]);
    expect(clause).toContain("dressed in blue jeans and a white polo shirt");
    expect(clause).not.toContain("hair");
  });

  /** The failing case: two people undressed, so the outfit cannot tell them apart. */
  it("falls through to hair when two people are undressed", () => {
    const clause = swapTargetClause(MARA, [DANE, STRANGER]);
    expect(clause).toContain("completely naked");
    expect(clause).toContain("honey-blonde hair");
  });

  /** Passes chain, and until now nothing told a later one to leave the earlier alone. */
  it("protects the other people in the frame", () => {
    expect(swapTargetClause(MARA, [DANE], "krea")).toContain(
      "Leave every other person in the first image exactly as they are",
    );
    expect(swapTargetClause(MARA, [DANE], "qwen")).toContain(
      "Leave every other person in Picture 1 exactly as they are",
    );
  });

  /**
   * "Picture 1" is Qwen's name for the frame and means nothing to Krea, whose
   * own prompt calls it the first image.
   */
  it("names the frame the way the chosen engine does", () => {
    expect(swapTargetClause(MARA, [DANE], "qwen")).toContain("In Picture 1");
    expect(swapTargetClause(MARA, [DANE], "krea")).not.toContain("Picture 1");
    expect(swapTargetClause(MARA, [DANE], "krea")).toContain("In the first image");
  });

  /** The word that caused the failure must not come back through the wardrobe. */
  it("does not describe a naked subject by a colour another person is wearing", () => {
    expect(swapTargetClause(MARA, [DANE, STRANGER])).not.toMatch(/white/i);
  });

  it("says nothing useful rather than something wrong when it cannot tell", () => {
    const nobody = { wardrobe: undefined, description: "a person" };
    expect(swapTargetClause(nobody, [nobody])).toBe("");
  });
});
