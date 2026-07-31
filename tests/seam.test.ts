import { describe, it, expect } from "vitest";
import { seamBreak, shotPlanIssues, shotSizeOf } from "@/lib/media/seam";
import type { Scene } from "@/lib/schemas/storyboard";

/** The appended cast sheet, which is full of words a loose matcher would trip on. */
const CAST =
  " Character continuity — Tracey: A beautiful, athletic 52-year-old Caucasian woman, 5'4\" tall, " +
  "with honey-blonde shoulder-length voluminous wavy hair featuring lighter golden highlights and " +
  "soft layers. She has defined shoulders, toned arms, a narrow trim waist, slim hips no wider than " +
  "her shoulders, and long lean legs with defined quadriceps and calves.";

function scene(over: Partial<Scene> & { start?: string; end?: string }): Scene {
  const { start, end, ...rest } = over;
  return {
    id: "s",
    projectId: "p",
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    title: "t",
    sceneObjective: "o",
    storyBeat: "b",
    visualDescription: "",
    actionDescription: "a",
    cameraMovement: "m",
    transitionIn: "Cut",
    transitionOut: "Cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    dialogue: [],
    status: "generated",
    prompts: {
      startFramePrompt: start ?? "",
      endFramePrompt: end ?? "",
      imageNegativePrompt: "",
      videoPromptSegment: "",
      videoNegativePrompt: "",
      promptQualityChecklist: [],
    },
    ...rest,
  } as Scene;
}

describe("reading the shot size out of a prompt", () => {
  it("takes the size the prompt opens with", () => {
    expect(shotSizeOf("Wide shot, eye level, 35mm lens. In a dimly lit bar…")).toBe("wide");
    expect(shotSizeOf("Extreme close-up, low angle, 85mm lens. The palms of two men…")).toBe(
      "extreme_close",
    );
    expect(shotSizeOf("Medium close-up, eye level, The Husband sits at a table.")).toBe(
      "medium_close",
    );
  });

  /** "Medium close-up" contains "close-up", and the wrong read makes a real cut invisible. */
  it("prefers the longer phrase over the shorter one inside it", () => {
    expect(shotSizeOf("Extreme close-up of hands")).toBe("extreme_close");
    expect(shotSizeOf("Medium close-up of a face")).toBe("medium_close");
    expect(shotSizeOf("Extreme wide shot of the room")).toBe("extreme_wide");
  });

  /** The cast sheet is appended to every prompt and mentions shoulders and long legs. */
  it("ignores the cast sheet appended after the shot description", () => {
    expect(shotSizeOf(`Wide shot, eye level, 35mm lens.${CAST}`)).toBe("wide");
    expect(shotSizeOf(`Extreme close-up, low angle, 85mm lens.${CAST}`)).toBe("extreme_close");
  });

  it("returns nothing when the prompt never states a size", () => {
    expect(shotSizeOf("Tracey dances between two men in a bar.")).toBeUndefined();
    expect(shotSizeOf(undefined)).toBeUndefined();
  });
});

describe("deciding whether a scene can inherit the previous end frame", () => {
  /** The Bar Dance failure: wide two-shot to hands on a waist, frame reused anyway. */
  it("breaks the seam when the shot size changes", () => {
    const previous = scene({ end: `Wide shot, eye level, 35mm lens. The trio dance.${CAST}` });
    const next = scene({
      start: `Extreme close-up, low angle, 85mm lens. Palms press into her waist.${CAST}`,
      transitionIn: "Match cut",
    });
    expect(seamBreak(previous, next)).toEqual({
      reason: "shot_size_change",
      detail: "wide to extreme close-up",
    });
  });

  it("breaks the seam on a named transition even when the size is unchanged", () => {
    const previous = scene({ end: "Wide shot, eye level. The trio dance." });
    const next = scene({ start: "Wide shot, eye level. The trio dance on.", transitionIn: "Cross-dissolve" });
    expect(seamBreak(previous, next)?.reason).toBe("transition");
  });

  it("allows the seam when the action simply continues", () => {
    const previous = scene({ end: `Wide shot, eye level, 35mm lens. The trio dance.${CAST}` });
    const next = scene({
      start: `Wide shot, eye level, 35mm lens. The trio dance on.${CAST}`,
      transitionIn: "Continuous",
    });
    expect(seamBreak(previous, next)).toBeNull();
  });

  /**
   * Falling back to the scene description matters because it states the shot
   * even when the prompt agent left it out.
   */
  it("falls back to the visual description when a prompt omits the size", () => {
    const previous = scene({ end: "The trio dance.", visualDescription: "Wide shot, eye level." });
    const next = scene({
      start: "Palms press into her waist.",
      visualDescription: "Extreme close-up, low angle.",
      transitionIn: "Continuous",
    });
    expect(seamBreak(previous, next)?.reason).toBe("shot_size_change");
  });

  /** With no size anywhere, a stated transition is the only evidence left. */
  it("does not invent a cut when neither scene states a shot size", () => {
    const previous = scene({ end: "The trio dance." });
    const next = scene({ start: "They dance on.", transitionIn: "Continuous" });
    expect(seamBreak(previous, next)).toBeNull();
  });
});

/**
 * A shot plan that contradicts the take it claims to be.
 *
 * Three faults found in live plans on the same project. Chaining the seams
 * alone was not enough: the model moved the contradiction inside the segments,
 * writing "STARTS CU -> ENDS MWS, push-in" twice, and swapped lens and camera
 * height partway through a take that cannot stop.
 */
describe("checking a shot plan against the take it claims to be", () => {
  it("finds nothing in a plan that holds together", () => {
    expect(
      shotPlanIssues({
        "1": "STARTS WS -> ENDS WS, 35mm, eye level, static",
        "2": "STARTS WS -> ENDS MCU, 35mm, eye level, slow push-in",
        "3": "STARTS MCU -> ENDS MCU, 35mm, eye level, pan",
      }),
    ).toEqual([]);
  });

  it("reports a segment opening on a size the last one never reached", () => {
    const issues = shotPlanIssues({
      "1": "STARTS WS -> ENDS WS, 35mm, eye level, static",
      "2": "STARTS ECU -> ENDS ECU, 35mm, eye level, static",
    });
    expect(issues).toEqual([
      { kind: "seam", at: 2, detail: "opens on extreme close-up but segment 1 ended on wide" },
    ]);
  });

  /** The exact live failure, in the model's own wording. */
  it("catches a push-in that ends wider than it started", () => {
    const issues = shotPlanIssues({
      "9": "STARTS CU -> ENDS MWS, 85mm, low, push-in to capture her arched back",
    });
    expect(issues).toEqual([
      { kind: "move", at: 9, detail: "pushes in but ends wider (close-up to medium wide)" },
    ]);
  });

  it("catches a pull-out that ends tighter", () => {
    const issues = shotPlanIssues({ "1": "STARTS WS -> ENDS CU, 35mm, eye level, pull-out" });
    expect(issues[0]!.kind).toBe("move");
    expect(issues[0]!.detail).toMatch(/pulls out but ends tighter/);
  });

  /** A take that never stops cannot change lens. */
  it("reports two lenses across one take", () => {
    const issues = shotPlanIssues({
      "1": "STARTS WS -> ENDS WS, 35mm, eye level, static",
      "2": "STARTS WS -> ENDS WS, 85mm, eye level, static",
    });
    expect(issues.find((i) => i.kind === "lens")?.detail).toBe("35mm, 85mm");
  });

  it("reports a camera height that moves with nothing to carry it", () => {
    const issues = shotPlanIssues({
      "1": "STARTS MS -> ENDS MS, 35mm, eye level, static",
      "2": "STARTS MS -> ENDS MS, 35mm, low, static",
    });
    expect(issues.find((i) => i.kind === "height")).toBeDefined();
  });

  /** An operator walks and a crane rises, so a moving camera may end up elsewhere. */
  it("allows a height change when the camera is moving", () => {
    expect(
      shotPlanIssues({
        "1": "STARTS MS -> ENDS MS, 35mm, eye level, static",
        "2": "STARTS MS -> ENDS MS, 35mm, low, crane down as she kneels",
      }),
    ).toEqual([]);
  });

  /** "cowboy" is a real shot size; leaving it out reported a seam that was fine. */
  it("knows a cowboy shot is a size", () => {
    expect(shotSizeOf("STARTS cowboy -> ENDS cowboy, 35mm")).toBe("cowboy");
    expect(
      shotPlanIssues({
        "10": "STARTS MWS -> ENDS cowboy, 35mm, eye level, tracking",
        "11": "STARTS cowboy -> ENDS cowboy, 35mm, eye level, arc",
      }),
    ).toEqual([]);
  });

  it("ignores entries with no size to compare", () => {
    expect(shotPlanIssues({ "1": "handheld, motivated by the argument" })).toEqual([]);
  });

  it("reads the segments in numeric order rather than as strings", () => {
    expect(
      shotPlanIssues({
        "9": "STARTS MS -> ENDS MS, 35mm, eye level",
        "10": "STARTS MS -> ENDS MS, 35mm, eye level",
        "2": "STARTS MS -> ENDS MS, 35mm, eye level",
      }),
    ).toEqual([]);
  });
});