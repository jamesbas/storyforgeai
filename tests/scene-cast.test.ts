import { describe, it, expect } from "vitest";
import { charactersInFrame, charactersInScene } from "@/lib/agents/scene-cast";
import type { Character } from "@/lib/schemas/character";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * Who is actually in a shot.
 *
 * The cast sheet, the reference photographs and the face swap were applied per
 * project, so a scene of four men at a poker table carried a description of a
 * woman who is not in it, her photograph as a reference image, and her face as
 * a swap target — while the agents were being told to name a character only in
 * the shots they appear in.
 */

const character = (id: string, name: string): Character => ({
  id,
  name,
  description: `${name} looks a certain way.`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const MARA = character("char-mara", "Mara");
const DAN = character("char-dan", "Dan");

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "p1-scene-001",
    projectId: "p1",
    sceneNumber: 1,
    title: "The bet",
    startTimeSeconds: 0,
    endTimeSeconds: 8,
    targetDurationSeconds: 8,
    sceneObjective: "Establish the game",
    storyBeat: "The stakes are set",
    visualDescription: "Four men in their late 40s are seated around a cluttered dining table.",
    actionDescription: "One man tosses a handful of playing cards onto the wooden surface.",
    cameraMovement: "Static wide shot",
    transitionIn: "Cut",
    transitionOut: "Cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    status: "planned",
    ...overrides,
  } as SceneDraft;
}

describe("reading a scene card for who is in it", () => {
  /** The exact case from Poker Night scene 1. */
  it("leaves a character out of a shot that never mentions them", () => {
    expect(charactersInScene(scene(), [MARA])).toEqual([]);
  });

  it("includes a character the scene names", () => {
    const named = scene({
      actionDescription: "Mara leans in the doorway watching the game.",
    });
    expect(charactersInScene(named, [MARA]).map((c) => c.name)).toEqual(["Mara"]);
  });

  it("finds a character who only speaks", () => {
    const speaking = scene({
      dialogue: [{ character: "Mara", line: "Deal me in." }],
    });
    expect(charactersInScene(speaking, [MARA])).toHaveLength(1);
  });

  it("picks out only the cast members present", () => {
    const partial = scene({ visualDescription: "Dan deals the next hand." });
    expect(charactersInScene(partial, [MARA, DAN]).map((c) => c.name)).toEqual(["Dan"]);
  });

  /** A declared list is the storyboard's own answer and outranks the text. */
  it("prefers the list the storyboard declared", () => {
    const declared = scene({
      charactersPresent: ["Mara"],
      visualDescription: "Four men are seated around the table.",
    });
    expect(charactersInScene(declared, [MARA, DAN]).map((c) => c.name)).toEqual(["Mara"]);
  });

  /** A declared name nobody recognises is a naming slip, not an empty scene. */
  it("falls back to the card when the declared names match nobody", () => {
    const declared = scene({
      charactersPresent: ["Traci"],
      actionDescription: "Mara pours a drink.",
    });
    expect(charactersInScene(declared, [MARA]).map((c) => c.name)).toEqual(["Mara"]);
  });

  /** "Dan" must not match inside "Dance" or "Daniel". */
  it("matches whole names rather than fragments", () => {
    const danger = scene({ visualDescription: "Dancers crowd the floor near a danger sign." });
    expect(charactersInScene(danger, [DAN])).toEqual([]);
  });

  it("is case-insensitive", () => {
    const shouty = scene({ actionDescription: "MARA slams the door." });
    expect(charactersInScene(shouty, [MARA])).toHaveLength(1);
  });

  it("has nothing to say when no cast is pinned", () => {
    expect(charactersInScene(scene(), [])).toEqual([]);
  });
});

/**
 * A card and a frame disagree routinely, and the sheet is appended to a frame.
 * A watcher the card seats in the corner chair but the shot frames out still
 * arrives carrying "wearing exactly", which is the last thing the image model
 * reads — so his clothes land on whoever is actually in shot.
 */
describe("narrowing the cast to what one frame shows", () => {
  it("drops a character the frame does not name", () => {
    const body = "Mara lies back as a muscular man settles over her. Exactly two people are in frame.";
    expect(charactersInFrame(body, [DAN, MARA])).toEqual([MARA]);
  });

  it("keeps a character the frame puts in the background", () => {
    const body = "Mara walks to the bed. In the background, Dan sits in a corner chair.";
    expect(charactersInFrame(body, [DAN, MARA])).toEqual([DAN, MARA]);
  });

  /** A frame can describe people without naming them, and an empty sheet
   *  would drop face continuity altogether. */
  it("falls back to the scene cast when the frame names nobody", () => {
    const body = "A close-up of one woman and one man, lit from the side.";
    expect(charactersInFrame(body, [DAN, MARA])).toEqual([DAN, MARA]);
  });
});
