import { describe, it, expect } from "vitest";
import { castPromptSuffix, castSheet, castSystemDirective } from "@/lib/agents/cast";
import { explicitnessDirective, isExplicitProject } from "@/lib/agents/explicitness";
import { isTightShot } from "@/lib/media/seam";
import type { Character } from "@/lib/schemas/character";
import type { Project } from "@/lib/schemas/project";

/**
 * Prompts for explicit work.
 *
 * A scene written as a sexual act produced a prompt that named no anatomy, and
 * ended with an instruction to keep her clothes on. Three separate causes: the
 * agent was never told the piece was explicit, wardrobe had no way to express
 * its own absence, and a head-to-toe description was appended to a close-up.
 */

const TRACEY: Character = {
  id: "char-tracey",
  name: "Tracey",
  description: "Tracey: A woman in her fifties with honey-blonde hair.",
  facialDescription: "Green eyes and a broad mouth.",
  wardrobe: "short black silk robe",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    title: "T",
    concept: "c",
    style: "erotic art film",
    tone: "erotic",
    audience: "adults only, explicit content",
    ...overrides,
  } as Project;
}

describe("telling the agent the work is explicit", () => {
  it("recognises an explicit audience", () => {
    expect(isExplicitProject(project())).toBe(true);
  });

  it("recognises an explicit tone even with a general audience", () => {
    expect(isExplicitProject(project({ audience: "adults", tone: "raw and carnal" }))).toBe(true);
  });

  it("says nothing for work that is not explicit", () => {
    const tame = project({ audience: "families", tone: "inspirational" });
    expect(isExplicitProject(tame)).toBe(false);
    expect(explicitnessDirective(tame, "image")).toBe("");
  });

  /** The preset descriptions existed and reached no model. */
  it("carries the preset's own wording to the model", () => {
    expect(explicitnessDirective(project(), "image")).toContain(
      "Nothing is softened, implied or cut away from",
    );
  });

  it("names euphemism as the failure to avoid", () => {
    const directive = explicitnessDirective(project(), "image");
    expect(directive).toContain("the point of contact");
    expect(directive).toMatch(/renders nouns/);
  });

  it("asks the clip prompt for movement rather than a held frame", () => {
    expect(explicitnessDirective(project(), "video")).toMatch(/rhythm, direction, depth and pace/);
  });

  /**
   * The planning agents write the card the render prompt is built from, so an
   * act described obliquely there cannot be recovered downstream.
   */
  it("tells the planning agents to describe the act, not the mood around it", () => {
    const directive = explicitnessDirective(project(), "plan");
    expect(directive).toMatch(/must describe the act/);
    expect(directive).toMatch(/fade out, cut away/);
    expect(directive).toContain("they come together");
  });

  it("does not tell a planning agent to write a still frame", () => {
    expect(explicitnessDirective(project(), "plan")).not.toMatch(/one still frame/);
  });

  it("stays silent for tame work whatever the caller asks for", () => {
    const tame = project({ audience: "families", tone: "inspirational" });
    for (const kind of ["image", "video", "plan"] as const) {
      expect(explicitnessDirective(tame, kind)).toBe("");
    }
  });
});

describe("nudity as a wardrobe state", () => {
  /** The defect: the last line of an explicit prompt put her clothes back on. */
  it("states the absence instead of wearing it", () => {
    const sheet = castSheet([TRACEY], true, { "char-tracey": "nude" });
    expect(sheet).toContain("completely naked with no clothing.");
    expect(sheet).not.toContain("wearing nude");
  });

  it("accepts the other ways of saying it", () => {
    for (const word of ["naked", "Fully nude", "undressed", "no clothing"]) {
      expect(castSheet([TRACEY], true, { "char-tracey": word })).toContain("completely naked");
    }
  });

  /** Bound to the person, not stated after them, so it cannot drift to another body. */
  it("leaves a real outfit alone", () => {
    expect(castSheet([TRACEY], true)).toContain(", dressed in short black silk robe.");
  });

  /** "Robe open" is not nudity, and reads correctly as an outfit. */
  it("does not mistake a partial state for nudity", () => {
    const sheet = castSheet([TRACEY], true, { "char-tracey": "black silk robe, open" });
    expect(sheet).toContain(", dressed in black silk robe, open.");
  });

  /** A planning agent is writing the record, and keeps the explicit form. */
  it("keeps the standalone clause for planning agents", () => {
    expect(castSheet([TRACEY], false)).toContain("Wearing exactly: short black silk robe.");
  });
});

/**
 * The sheet has a total budget rather than a per-person allowance, because a
 * per-person one grows with the cast: at a fixed 220 characters each, a
 * six-hander is back to the 1500 characters that failed.
 */
describe("keeping the sheet the same size however big the cast", () => {
  const long = (name: string) => ({
    ...TRACEY,
    id: `char-${name}`,
    name,
    description: `${name} is a person. ${"Every detail of their appearance recorded at length. ".repeat(12)}`,
  });

  const sheetFor = (count: number) =>
    castSheet(
      Array.from({ length: count }, (_, i) => long(`Person${i}`)),
      true,
    );

  /** What matters is the share each person gets, not the total, which a long
   *  wardrobe can inflate on its own. */
  it("gives each person less as the cast grows", () => {
    const perPersonAtTwo = sheetFor(2).length / 2;
    const perPersonAtSix = sheetFor(6).length / 6;
    expect(perPersonAtSix).toBeLessThan(perPersonAtTwo * 0.8);
  });

  /** A crowd is trimmed, but never past the point of identifying anybody. */
  it("keeps every person identifiable in a crowd", () => {
    const sheet = sheetFor(6);
    for (let i = 0; i < 6; i += 1) expect(sheet).toContain(`Person${i}:`);
    expect(sheet).toContain("is a person");
  });

  it("still spends generously on a single figure", () => {
    expect(sheetFor(1).length).toBeGreaterThan(200);
  });
});

describe("scaling the sheet to the shot", () => {
  const photographed = { ...TRACEY, referenceImages: ["tracey.png"] };

  it("keeps the full description when text is the only identity signal", () => {
    const sheet = castSheet([TRACEY], true, undefined, { tightShot: true });
    expect(sheet).toContain("honey-blonde hair");
  });

  /** With a photograph carrying the likeness, the inventory is out of frame. */
  it("trims to name and wardrobe on a close-up with a reference photo", () => {
    const sheet = castSheet([photographed], true, undefined, { tightShot: true });
    expect(sheet).not.toContain("honey-blonde hair");
    expect(sheet).toContain("Tracey:");
    expect(sheet).toContain("Wearing exactly: short black silk robe.");
  });

  it("keeps the description on a wider shot", () => {
    const sheet = castSheet([photographed], true, undefined, { tightShot: false });
    expect(sheet).toContain("honey-blonde hair");
  });

  /** A written face competes with a framing that crops the head. */
  it("withholds the face when the shot does not show one", () => {
    const noFace = { ...TRACEY, referenceImages: undefined };
    expect(castSheet([noFace], true, undefined, { faceVisible: false })).not.toContain("Green eyes");
    expect(castSheet([noFace], true, undefined, { faceVisible: true })).toContain("Green eyes");
  });

  it("still gives planning agents the whole description", () => {
    expect(castSheet([photographed], false, undefined, { tightShot: true })).toContain(
      "honey-blonde hair",
    );
  });
});

describe("reading the shot size of a prompt", () => {
  it("treats a close-up and tighter as tight", () => {
    expect(isTightShot("Close-up, low angle. A tight shot of...")).toBe(true);
    expect(isTightShot("Extreme close-up of her hands.")).toBe(true);
  });

  it("does not treat a medium or wider as tight", () => {
    expect(isTightShot("Wide shot, eye level. Four men at a table.")).toBe(false);
    expect(isTightShot("Medium shot of the pair.")).toBe(false);
  });
});

describe("the doubled name", () => {
  /** The stored description opened with the name, and the sheet added it again. */
  it("does not write the name twice", () => {
    expect(castPromptSuffix([TRACEY])).toContain("Tracey: A woman in her fifties");
    expect(castPromptSuffix([TRACEY])).not.toContain("Tracey: Tracey:");
  });
});

/**
 * Scoping the cast sheet to the scene made the render directive vanish along
 * with it: a scene the pinned cast is absent from got an empty directive, so
 * nothing told the agent to describe the people who *were* there. Four men at a
 * poker table came back as a pair of hands.
 */
describe("people who are not in the pinned cast", () => {
  it("still asks for a description when the scene has no pinned cast", () => {
    const directive = castSystemDirective([], true);
    expect(directive).toMatch(/must be described in your own/);
    expect(directive).toMatch(/specific named garments/);
  });

  it("asks for it alongside the cast rules when there is a cast", () => {
    expect(castSystemDirective([TRACEY], true)).toMatch(/must be described in your own/);
  });

  /**
   * Length is what went wrong: one character described at four times another's
   * length was rendered twice while the other was dropped.
   */
  it("asks for those descriptions to be compact and evenly weighted", () => {
    const directive = castSystemDirective([TRACEY], true);
    expect(directive).toMatch(/compact clause/);
    expect(directive).toMatch(/roughly the same length/);
    expect(directive).toMatch(/same clause as the person/);
  });

  /** Planning agents describe everyone anyway; this is a render-prompt rule. */
  it("says nothing to a planning agent with no cast", () => {
    expect(castSystemDirective([])).toBe("");
  });});
