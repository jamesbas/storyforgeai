import { describe, it, expect } from "vitest";
import { checkPromptFamily, promptsPredateGuidance } from "@/lib/agents/prompt-family";
import { familyLabel } from "@/lib/wangp/family";

/**
 * Noticing that a prompt was written for a model the project no longer uses.
 *
 * The failure this guards against is silent by nature: a clip prompt written
 * for LTX renders perfectly well on H3, it is simply far too short and uses the
 * wrong camera words. Nothing in the output says so.
 */

const scene = (prompts: {
  videoSoundscape?: string;
  videoScore?: string;
  videoPromptFamily?: string;
}) => ({ prompts });

describe("a stamped storyboard", () => {
  it("spots prompts written for another family", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({ videoPromptFamily: "ltx" })],
    });
    expect(check).toEqual({
      writtenFor: "ltx",
      certainty: "stamped",
      staleScenes: 1,
      totalScenes: 1,
    });
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
    expect(check).toMatchObject({ writtenFor: "minimax", certainty: "inferred" });
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

describe("a partly stale storyboard", () => {
  // The case that motivated counting: one good scene used to silence the rest.
  it("warns when only some scenes look wrong", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({ videoSoundscape: "Rain on glass." }), scene({}), scene({})],
    });
    expect(check).toMatchObject({ staleScenes: 2, totalScenes: 3, certainty: "inferred" });
  });

  it("counts a half-rewritten storyboard", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({ videoPromptFamily: "minimax" }), scene({ videoPromptFamily: "ltx" })],
    });
    expect(check).toMatchObject({ staleScenes: 1, totalScenes: 2, writtenFor: "ltx" });
  });

  it("accepts a score alone as evidence H3 wrote the scene", () => {
    // A shot with no ambience but a score is still an H3-written scene.
    expect(
      checkPromptFamily({
        videoModel: "minimax_h3_fl2va",
        scenes: [scene({ videoScore: "Low strings, slow." })],
      }),
    ).toBeNull();
  });

  it("ignores whitespace masquerading as an answer", () => {
    const check = checkPromptFamily({
      videoModel: "minimax_h3_fl2va",
      scenes: [scene({ videoSoundscape: "   " })],
    });
    expect(check?.staleScenes).toBe(1);
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

describe("guidance that has moved on", () => {
  // A prompt can be stale because the wording the agents were given changed,
  // with nothing about the project having moved — which the family check
  // cannot see, and which left the rewrite unreachable when it was the only
  // thing wrong.
  it("spots a scene written under an older version", () => {
    expect(promptsPredateGuidance(["video-prompt-v1"], "video-prompt-v2")).toBe(true);
  });

  it("stays quiet when every scene is current", () => {
    expect(promptsPredateGuidance(["video-prompt-v2", "video-prompt-v2"], "video-prompt-v2")).toBe(
      false,
    );
  });

  it("claims nothing for a scene with no recorded version", () => {
    expect(promptsPredateGuidance([undefined, undefined], "video-prompt-v2")).toBe(false);
  });

  it("flags a partly rewritten storyboard", () => {
    expect(promptsPredateGuidance(["video-prompt-v2", "video-prompt-v1"], "video-prompt-v2")).toBe(
      true,
    );
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
