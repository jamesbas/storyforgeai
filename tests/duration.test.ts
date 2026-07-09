import { describe, it, expect } from "vitest";
import { computeSegmentation } from "@/lib/duration";

describe("computeSegmentation", () => {
  it.each([
    [20, 1, 20, 0],
    [60, 3, 60, 0],
    [90, 5, 100, 10],
    [120, 6, 120, 0],
    [300, 15, 300, 0],
  ])(
    "requested %is -> %i segments, %is generated, %is trim",
    (requested, count, generated, trim) => {
      const seg = computeSegmentation(requested);
      expect(seg.segmentCount).toBe(count);
      expect(seg.generatedDurationSeconds).toBe(generated);
      expect(seg.finalTrimSeconds).toBe(trim);
      expect(seg.segmentSeconds).toBe(20);
    },
  );

  it("honors a custom segment duration", () => {
    const seg = computeSegmentation(45, 15);
    expect(seg.segmentCount).toBe(3);
    expect(seg.generatedDurationSeconds).toBe(45);
    expect(seg.finalTrimSeconds).toBe(0);
  });

  it("rejects non-positive durations", () => {
    expect(() => computeSegmentation(0)).toThrow();
    expect(() => computeSegmentation(-10)).toThrow();
    expect(() => computeSegmentation(Number.NaN)).toThrow();
  });
});
