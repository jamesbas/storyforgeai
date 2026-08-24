import { describe, expect, it } from "vitest";

import { foldWardrobeChanges } from "@/lib/agents/wardrobe";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";

const CHARACTER: Character = {
  id: "char-1",
  name: "Mara",
  description: "",
  wardrobe: "black satin lingerie",
} as Character;

function project(wardrobeChanges: Project["wardrobeChanges"]): Project {
  return { id: "p", wardrobeChanges } as Project;
}

const NUDE_FROM_STORY = {
  characterId: "char-1",
  wardrobe: "nude",
  mode: "between" as const,
  origin: "story" as const,
};

describe("a folded wardrobe change does not outlive the scene that asked for it", () => {
  it("drops a story-derived change when the scene is rewritten without one", () => {
    // Scene ids are reused across regenerations, so an entry folded from an
    // older draft re-attaches to whatever scene now occupies that slot.
    const before = project({ "p-scene-003": [NUDE_FROM_STORY] });
    const after = foldWardrobeChanges(before, [{ id: "p-scene-003", wardrobeChanges: [] }], [
      CHARACTER,
    ]);
    expect(after.wardrobeChanges?.["p-scene-003"]).toBeUndefined();
  });

  it("replaces a story-derived change when the new draft asks for a different one", () => {
    const before = project({ "p-scene-003": [NUDE_FROM_STORY] });
    const after = foldWardrobeChanges(
      before,
      [
        {
          id: "p-scene-003",
          wardrobeChanges: [
            { character: "Mara", newWardrobe: "a hotel robe", depictedOnScreen: true },
          ],
        },
      ],
      [CHARACTER],
    );
    expect(after.wardrobeChanges?.["p-scene-003"]).toEqual([
      { characterId: "char-1", wardrobe: "a hotel robe", mode: "within", origin: "story" },
    ]);
  });

  it("marks what it folds, so a later run can tell its own work apart", () => {
    const after = foldWardrobeChanges(
      project({}),
      [
        {
          id: "p-scene-003",
          wardrobeChanges: [{ character: "Mara", newWardrobe: "nude", depictedOnScreen: false }],
        },
      ],
      [CHARACTER],
    );
    expect(after.wardrobeChanges?.["p-scene-003"]?.[0]?.origin).toBe("story");
  });

  it("never discards a change somebody set by hand", () => {
    // The whole reason the old code refused to revisit an entry. A manual
    // change has no draft to be re-derived from, so rebuilding would delete it.
    const manual = { characterId: "char-1", wardrobe: "a hotel robe", mode: "within" as const };
    const before = project({ "p-scene-003": [manual] });
    const after = foldWardrobeChanges(before, [{ id: "p-scene-003", wardrobeChanges: [] }], [
      CHARACTER,
    ]);
    expect(after.wardrobeChanges?.["p-scene-003"]).toEqual([manual]);
  });

  it("lets a hand-set change win over one the story proposes for the same person", () => {
    const manual = { characterId: "char-1", wardrobe: "a hotel robe", mode: "within" as const };
    const after = foldWardrobeChanges(
      project({ "p-scene-003": [manual] }),
      [
        {
          id: "p-scene-003",
          wardrobeChanges: [{ character: "Mara", newWardrobe: "nude", depictedOnScreen: false }],
        },
      ],
      [CHARACTER],
    );
    expect(after.wardrobeChanges?.["p-scene-003"]).toEqual([manual]);
  });

  it("leaves scenes this run did not write about alone", () => {
    // A subset regeneration passes only the drafts it rebuilt.
    const before = project({ "p-scene-003": [NUDE_FROM_STORY], "p-scene-009": [NUDE_FROM_STORY] });
    const after = foldWardrobeChanges(before, [{ id: "p-scene-003", wardrobeChanges: [] }], [
      CHARACTER,
    ]);
    expect(after.wardrobeChanges?.["p-scene-009"]).toEqual([NUDE_FROM_STORY]);
  });

  it("returns the project untouched when nothing changed", () => {
    const before = project({ "p-scene-003": [NUDE_FROM_STORY] });
    const after = foldWardrobeChanges(
      before,
      [
        {
          id: "p-scene-003",
          wardrobeChanges: [{ character: "Mara", newWardrobe: "nude", depictedOnScreen: false }],
        },
      ],
      [CHARACTER],
    );
    expect(after).toBe(before);
  });
});
