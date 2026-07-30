import { describe, it, expect } from "vitest";
import { resolveResolution, stepFloorFor } from "@/lib/wangp/resolution";

/**
 * Frame size and quality.
 *
 * Both inputs were inert: every manifest wrote `DEFAULT_RESOLUTION` whatever
 * the project said, so a 9:16 short rendered landscape and draft/standard/high
 * changed nothing at all. The Help page described behaviour the build did not
 * have.
 */

const base = { fallback: "1280x720" as const };

describe("frame size from aspect ratio", () => {
  it("renders portrait for a vertical project", () => {
    expect(resolveResolution({ ...base, aspectRatio: "9:16", preset: "standard" })).toBe("720x1280");
  });

  it("renders square for a square project", () => {
    expect(resolveResolution({ ...base, aspectRatio: "1:1", preset: "standard" })).toBe("768x768");
  });

  it("scales along the preset", () => {
    expect(resolveResolution({ ...base, aspectRatio: "16:9", preset: "draft" })).toBe("848x480");
    expect(resolveResolution({ ...base, aspectRatio: "16:9", preset: "standard" })).toBe("1280x720");
    expect(resolveResolution({ ...base, aspectRatio: "16:9", preset: "high" })).toBe("1920x1088");
  });

  /** Every dimension must be a multiple of 16 or the model rejects it. */
  it("only produces sizes a diffusion model accepts", () => {
    for (const aspect of ["16:9", "9:16", "1:1"] as const) {
      for (const preset of ["draft", "standard", "high"] as const) {
        const [w, h] = resolveResolution({ ...base, aspectRatio: aspect, preset })
          .split("x")
          .map(Number);
        expect(w! % 16).toBe(0);
        expect(h! % 16).toBe(0);
      }
    }
  });

  /** Custom is the escape hatch: we cannot infer a shape, so the env value stands. */
  it("uses the configured fallback for a custom ratio", () => {
    expect(resolveResolution({ ...base, aspectRatio: "custom", preset: "high" })).toBe("1280x720");
  });
});

describe("snapping to what the model offers", () => {
  it("keeps an exact match", () => {
    expect(
      resolveResolution({
        ...base,
        aspectRatio: "16:9",
        preset: "standard",
        allowed: ["640x480", "1280x720", "1920x1088"],
      }),
    ).toBe("1280x720");
  });

  it("takes the closest offered size by pixel count", () => {
    // Target for 16:9 high is 1920x1088; 2048x1152 is far nearer than 848x480.
    expect(
      resolveResolution({
        ...base,
        aspectRatio: "16:9",
        preset: "high",
        allowed: ["848x480", "2048x1152"],
      }),
    ).toBe("2048x1152");
  });

  /**
   * A portrait project must never be snapped to a landscape size. Rendering the
   * wrong shape is a worse answer than rendering a slightly wrong size.
   */
  it("never crosses orientation", () => {
    expect(
      resolveResolution({
        ...base,
        aspectRatio: "9:16",
        preset: "standard",
        allowed: ["1280x720", "1920x1088", "544x960"],
      }),
    ).toBe("544x960");
  });

  it("falls back to the target when the offered list is unparseable", () => {
    expect(
      resolveResolution({
        ...base,
        aspectRatio: "16:9",
        preset: "standard",
        allowed: ["auto", "native"],
      }),
    ).toBe("1280x720");
  });
});

describe("the step floor", () => {
  it("scales with the preset", () => {
    expect(stepFloorFor("draft", 30)).toBe(18);
    expect(stepFloorFor("standard", 30)).toBe(30);
    expect(stepFloorFor("high", 30)).toBe(45);
  });

  it("never drops below one step", () => {
    expect(stepFloorFor("draft", 1)).toBe(1);
  });
});
