import { describe, it, expect } from "vitest";
import { familyLabel, familyOf } from "@/lib/wangp/family";

/**
 * Noticing that a prompt was written for a model the project no longer uses.
 *
 * The failure this guards against is silent by nature: a clip prompt written
 * for LTX renders perfectly well on H3, it is simply far too short and uses the
 * wrong camera words. Nothing in the output says so, which is why the stamp
 * exists and why an absent stamp must never be read as a mismatch.
 */

const staleFamily = (
  videoModel: string | undefined,
  stamped: readonly (string | undefined)[],
): string | undefined => {
  const family = videoModel ? familyOf(videoModel) : undefined;
  return family ? stamped.find((value) => value && value !== family) : undefined;
};

describe("stale prompt detection", () => {
  it("spots prompts written for another family", () => {
    expect(staleFamily("minimax_h3_fl2va", ["ltx", "ltx"])).toBe("ltx");
  });

  it("says nothing when the family still matches", () => {
    expect(staleFamily("minimax_h3_fl2va", ["minimax", "minimax"])).toBeUndefined();
  });

  it("treats the two H3 variants as different", () => {
    expect(staleFamily("minimax_h3_ref2va", ["minimax"])).toBe("minimax");
    expect(staleFamily("minimax_h3_fl2va", ["minimax_ref2va"])).toBe("minimax_ref2va");
  });

  it("claims nothing for a storyboard written before the stamp existed", () => {
    expect(staleFamily("minimax_h3_fl2va", [undefined, undefined])).toBeUndefined();
  });

  it("claims nothing when no model is pinned", () => {
    // An unpinned project falls through to the router, so there is no family to
    // be wrong about.
    expect(staleFamily(undefined, ["ltx"])).toBeUndefined();
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
