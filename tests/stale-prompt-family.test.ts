import { describe, it, expect } from "vitest";
import { checkPromptFamily } from "@/lib/agents/prompt-family";
import { familyLabel } from "@/lib/wangp/family";

/**
 * Noticing that a prompt was written for a model the project no longer uses.
 *
 * The failure this guards against is silent by nature: a clip prompt written
 * for LTX renders perfectly well on H3, it is simply far too short and uses the
 * wrong camera words. Nothing in the output says so.
 */

const scene = (prompts: { videoSoundscape?: string; videoPromptFamily?: string }) => ({ prompts });

describe("a stamped storyboard", () => {
  it("spots prompts written for another family", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({ videoPromptFamily: "ltx" })],
    });
    expect(check).toEqual({ writtenFor: "ltx", certainty: "stamped" });
  });

  it("says nothing when the family still matches", () => {
    expect(
      checkPromptFamily({
        videoModel: "minimax_h3_fl2va",
        scenes: [scene({ videoPromptFamily: "minimax" })],
      }),
    ).toBeNull();
  });

  it("treats the two H3 variants as different", () => {
    expect(
      checkPromptFamily({
        videoModel: "minimax_h3_ref2va",
        scenes: [scene({ videoPromptFamily: "minimax" })],
      })?.writtenFor,
    ).toBe("minimax");
  });
});

describe("a storyboard written before the stamp existed", () => {
  // `videoSoundscape` is requested by one branch of the directive only, so its
  // presence identifies the author even with no stamp to read.
  it("infers that H3 did not write prompts carrying no soundscape", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({}), scene({})],
    });
    expect(check?.certainty).toBe("inferred");
  });

  it("infers that H3 did write prompts carrying one", () => {
    expect(
      checkPromptFamily({
        videoModel: "minimax_h3_fl2va",
        scenes: [scene({ videoSoundscape: "Rain on glass." })],
      }),
    ).toBeNull();
  });

  it("catches the reverse move, away from H3", () => {
    const check = checkPromptFamily({
      videoModel: "ltx2_22B_distilled_1_1",
      scenes: [scene({ videoSoundscape: "Rain on glass." })],
    });
    expect(check).toEqual({ writtenFor: "minimax", certainty: "inferred" });
  });

  it("stays quiet where the inference proves nothing", () => {
    // Neither family asks for the field, so its absence says nothing at all.
    expect(
      checkPromptFamily({ videoModel: "ltx2_22B_distilled_1_1", scenes: [scene({})] }),
    ).toBeNull();
  });

  it("prefers the stamp over the inference when both are available", () => {
    expect(
      checkPromptFamily({
        videoModel: "minimax_h3_fl2va",
        scenes: [scene({ videoPromptFamily: "minimax" })],
      }),
    ).toBeNull();
  });
});

describe("cases that must never warn", () => {
  it("claims nothing when no model is pinned", () => {
    expect(checkPromptFamily({ videoModel: undefined, scenes: [scene({})] })).toBeNull();
  });

  it("claims nothing for an unrecognised model", () => {
    expect(checkPromptFamily({ videoModel: "some_new_thing", scenes: [scene({})] })).toBeNull();
  });

  it("claims nothing without a storyboard", () => {
    expect(checkPromptFamily({ videoModel: "minimax_h3_fl2va", scenes: [] })).toBeNull();
  });
});

describe("familyLabel", () => {
  it("names both H3 variants apart", () => {
    expect(familyLabel("minimax")).toContain("first and last");
    expect(familyLabel("minimax_ref2va")).toContain("reference");
  });

  it("falls back rather than showing a raw token", () => {
    expect(familyLabel(undefined)).toBe("an unrecognised model");
    expect(familyLabel("not_a_family")).toBe("an unrecognised model");
  });
});
