import { describe, expect, it } from "vitest";
import { rebuiltPrompts, sheetIsStale } from "@/lib/agents/cast-sheet";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import type { Character } from "@/lib/schemas/character";
import type { Project } from "@/lib/schemas/project";
import type { Scene } from "@/lib/schemas/storyboard";

const MARA = {
  id: "c1",
  name: "Mara",
  description: "A 52-year-old woman.",
  wardrobe: "a black silk slip",
  referenceImagePaths: [],
} as unknown as Character;

const scene = (id: string, sceneNumber: number, tail: string) =>
  ({
    id,
    projectId: "p1",
    sceneNumber,
    title: `Scene ${sceneNumber}`,
    subjectFaceVisible: true,
    charactersPresent: ["Mara"],
    prompts: {
      startFramePrompt: `A room.${tail}`,
      endFramePrompt: `A room.${tail}`,
      videoPromptSegment: "She moves. The start frame fixes how Mara looks.",
      imageNegativePrompt: "",
      videoNegativePrompt: "",
    },
  }) as unknown as Scene;

const SHEET =
  " Character continuity — Mara: A 52-year-old woman. Wearing exactly: a black silk slip.";

const project = (wardrobeChanges?: Project["wardrobeChanges"]) =>
  ({ id: "p1", characterWardrobe: { c1: "a black silk slip" }, wardrobeChanges }) as unknown as Project;

describe("cast sheet staleness", () => {
  it("is not stale when the appended text already matches", () => {
    const s = scene("s1", 1, SHEET);
    const timeline = wardrobeTimeline(project(), [s], [MARA]);
    const settled = {
      ...s,
      prompts: { ...s.prompts, ...rebuiltPrompts(s, [MARA], timeline.get("s1")) },
    } as Scene;
    expect(sheetIsStale(settled, [MARA], timeline.get("s1"))).toBe(false);
  });

  /**
   * The case the screen used to miss entirely: setting a costume change leaves
   * the stored prompt saying the old outfit, and the render reads the stored
   * prompt.
   */
  it("goes stale once a costume change is set for the scene", () => {
    const s = scene("s1", 1, SHEET);
    const changed = project({ s1: [{ characterId: "c1", wardrobe: "nude", mode: "between" }] });
    const timeline = wardrobeTimeline(changed, [s], [MARA]);

    expect(sheetIsStale(s, [MARA], timeline.get("s1"))).toBe(true);
    expect(rebuiltPrompts(s, [MARA], timeline.get("s1")).endFramePrompt).toContain(
      "completely naked with no clothing.",
    );
  });

  it("carries a change forward to later scenes", () => {
    const scenes = [scene("s1", 1, SHEET), scene("s2", 2, SHEET)];
    const changed = project({ s1: [{ characterId: "c1", wardrobe: "nude", mode: "between" }] });
    const timeline = wardrobeTimeline(changed, scenes, [MARA]);
    expect(rebuiltPrompts(scenes[1]!, [MARA], timeline.get("s2")).endFramePrompt).toContain(
      "completely naked with no clothing.",
    );
  });

  it("still drops a character the scene does not name", () => {
    const s = scene("s1", 1, SHEET);
    const absent = { ...s, charactersPresent: [] } as Scene;
    const timeline = wardrobeTimeline(project(), [absent], [MARA]);
    expect(sheetIsStale(absent, [MARA], timeline.get("s1"))).toBe(true);
    expect(rebuiltPrompts(absent, [MARA], timeline.get("s1")).endFramePrompt).not.toContain(
      "Mara",
    );
  });
});
