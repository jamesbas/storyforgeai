import { describe, it, expect } from "vitest";
import { createProjectSchema } from "@/lib/schemas/intake";
import { storyboardSnapshotSchema } from "@/lib/schemas/storyboard";

describe("createProjectSchema", () => {
  it("applies defaults for a minimal input", () => {
    const parsed = createProjectSchema.parse({
      concept: "A robot paints a sunset.",
      requestedDurationSeconds: 60,
    });
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.generationMode).toBe("video_segments");
    expect(parsed.creativeMode).toBe("film_short");
    expect(parsed.narrationRequired).toBe(false);
  });

  it("rejects empty concept", () => {
    expect(() =>
      createProjectSchema.parse({ concept: "", requestedDurationSeconds: 60 }),
    ).toThrow();
  });

  it("rejects invalid aspect ratio", () => {
    expect(() =>
      createProjectSchema.parse({
        concept: "x",
        requestedDurationSeconds: 60,
        aspectRatio: "4:3",
      }),
    ).toThrow();
  });

  it("rejects non-positive duration", () => {
    expect(() =>
      createProjectSchema.parse({ concept: "x", requestedDurationSeconds: 0 }),
    ).toThrow();
  });
});

describe("storyboardSnapshotSchema", () => {
  it("rejects a malformed snapshot", () => {
    expect(() => storyboardSnapshotSchema.parse({ scenes: [] })).toThrow();
  });
});
