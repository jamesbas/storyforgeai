import { describe, it, expect } from "vitest";
import { isUndressed, wardrobeContradictions } from "@/lib/agents/wardrobe";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";

/**
 * Finding the scenes where the outfit contradicts the action.
 *
 * The wardrobe is appended last, which is the strongest position in a prompt,
 * so a sex scene carrying a robe on the cast sheet renders the robe. Reading
 * eighteen cards to find those by hand is the sort of work a person should not
 * be doing.
 */

const TRACEY: Character = {
  id: "char-tracey",
  name: "Tracey",
  description: "A woman in her fifties.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    characterWardrobe: { "char-tracey": "short black silk robe" },
    ...overrides,
  } as Project;
}

function scene(n: number, action: string) {
  return {
    id: `p1-scene-00${n}`,
    sceneNumber: n,
    title: `Scene ${n}`,
    visualDescription: "The bedroom at night.",
    actionDescription: action,
    storyBeat: "The beat.",
  };
}

describe("spotting an outfit that contradicts the action", () => {
  it("flags a scene whose action is only possible undressed", () => {
    const scenes = [scene(1, "Tracey pours a drink."), scene(2, "He penetrates her slowly.")];
    const found = wardrobeContradictions(project(), scenes, [TRACEY]);

    expect(found).toHaveLength(1);
    expect(found[0]!.sceneNumber).toBe(2);
    expect(found[0]!.characters).toEqual(["Tracey"]);
  });

  /** Once nude is set, the scene is no longer a contradiction. */
  it("stops flagging once the wardrobe agrees", () => {
    const scenes = [scene(2, "He penetrates her slowly.")];
    const withNude = project({
      wardrobeChanges: {
        "p1-scene-002": [{ characterId: "char-tracey", wardrobe: "nude", mode: "between" }],
      },
    });
    expect(wardrobeContradictions(withNude, scenes, [TRACEY])).toEqual([]);
  });

  /** A change carries forward, so a later scene inherits the nude state. */
  it("respects a nude state established in an earlier scene", () => {
    const scenes = [scene(1, "She undresses."), scene(2, "He thrusts into her.")];
    const carried = project({
      wardrobeChanges: {
        "p1-scene-001": [{ characterId: "char-tracey", wardrobe: "nude", mode: "within" }],
      },
    });
    expect(wardrobeContradictions(carried, scenes, [TRACEY])).toEqual([]);
  });

  /**
   * Undressing and kissing are excluded on purpose: a scene can contain both
   * and end with the clothes on, and a change carries forward, so a false
   * positive would misdress every scene after it.
   */
  it("does not flag a scene that only builds towards it", () => {
    const scenes = [scene(1, "They kiss and she begins to undress him.")];
    expect(wardrobeContradictions(project(), scenes, [TRACEY])).toEqual([]);
  });

  it("says nothing when no cast is pinned", () => {
    expect(wardrobeContradictions(project(), [scene(1, "He penetrates her.")], [])).toEqual([]);
  });

  it("says nothing when the character has no stated wardrobe at all", () => {
    const bare = project({ characterWardrobe: {} });
    expect(wardrobeContradictions(bare, [scene(1, "He penetrates her.")], [TRACEY])).toEqual([]);
  });

  /**
   * The act is scene-level, the undressing is per character. In a scene built
   * around a watcher, the clothed one is deliberate — and the bulk action
   * skips a scene that already carries a change, so flagging it would offer a
   * fix that does nothing and a banner that never clears.
   */
  it("leaves a scene alone once someone has ruled on its wardrobe", () => {
    const JAIME: Character = { ...TRACEY, id: "char-jaime", name: "Jaime" };
    const watched = project({
      characterWardrobe: { "char-tracey": "short black silk robe", "char-jaime": "blue jeans" },
      wardrobeChanges: {
        "p1-scene-002": [{ characterId: "char-tracey", wardrobe: "nude", mode: "between" }],
      },
    });
    const scenes = [scene(2, "He watches as she climaxes.")];

    expect(wardrobeContradictions(watched, scenes, [TRACEY, JAIME])).toEqual([]);
  });
});

describe("recognising an undressed wardrobe", () => {
  it("matches the states the cast sheet renders as nudity", () => {
    for (const word of ["nude", "Naked", "fully nude", "no clothing", "undressed"]) {
      expect(isUndressed(word)).toBe(true);
    }
  });

  it("does not treat a partial state as nudity", () => {
    expect(isUndressed("black silk robe, open")).toBe(false);
    expect(isUndressed("topless in jeans")).toBe(false);
  });
});
