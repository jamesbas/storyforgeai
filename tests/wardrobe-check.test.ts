import { describe, it, expect } from "vitest";
import { isNudeState, isUndressed, nudeWithDetail, wardrobeContradictions, wardrobeSentence } from "@/lib/agents/wardrobe";
import { castPromptSuffix } from "@/lib/agents/cast";
import { inventedGarments, wardrobeConflicts } from "@/lib/agents/prompt-gate";
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

const MARA: Character = {
  id: "char-mara",
  name: "Mara",
  description: "A woman in her fifties.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    characterWardrobe: { "char-mara": "short black silk robe" },
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
    const scenes = [scene(1, "Mara pours a drink."), scene(2, "He penetrates her slowly.")];
    const found = wardrobeContradictions(project(), scenes, [MARA]);

    expect(found).toHaveLength(1);
    expect(found[0]!.sceneNumber).toBe(2);
    expect(found[0]!.characters).toEqual(["Mara"]);
  });

  /** Once nude is set, the scene is no longer a contradiction. */
  it("stops flagging once the wardrobe agrees", () => {
    const scenes = [scene(2, "He penetrates her slowly.")];
    const withNude = project({
      wardrobeChanges: {
        "p1-scene-002": [{ characterId: "char-mara", wardrobe: "nude", mode: "between" }],
      },
    });
    expect(wardrobeContradictions(withNude, scenes, [MARA])).toEqual([]);
  });

  /** A change carries forward, so a later scene inherits the nude state. */
  it("respects a nude state established in an earlier scene", () => {
    const scenes = [scene(1, "She undresses."), scene(2, "He thrusts into her.")];
    const carried = project({
      wardrobeChanges: {
        "p1-scene-001": [{ characterId: "char-mara", wardrobe: "nude", mode: "within" }],
      },
    });
    expect(wardrobeContradictions(carried, scenes, [MARA])).toEqual([]);
  });

  /**
   * Undressing and kissing are excluded on purpose: a scene can contain both
   * and end with the clothes on, and a change carries forward, so a false
   * positive would misdress every scene after it.
   */
  it("does not flag a scene that only builds towards it", () => {
    const scenes = [scene(1, "They kiss and she begins to undress him.")];
    expect(wardrobeContradictions(project(), scenes, [MARA])).toEqual([]);
  });

  it("says nothing when no cast is pinned", () => {
    expect(wardrobeContradictions(project(), [scene(1, "He penetrates her.")], [])).toEqual([]);
  });

  it("says nothing when the character has no stated wardrobe at all", () => {
    const bare = project({ characterWardrobe: {} });
    expect(wardrobeContradictions(bare, [scene(1, "He penetrates her.")], [MARA])).toEqual([]);
  });

  /**
   * The act is scene-level, the undressing is per character. In a scene built
   * around a watcher, the clothed one is deliberate — and the bulk action
   * skips a scene that already carries a change, so flagging it would offer a
   * fix that does nothing and a banner that never clears.
   */
  it("leaves a scene alone once someone has ruled on its wardrobe", () => {
    const DANE: Character = { ...MARA, id: "char-dane", name: "Dane" };
    const watched = project({
      characterWardrobe: { "char-mara": "short black silk robe", "char-dane": "blue jeans" },
      wardrobeChanges: {
        "p1-scene-002": [{ characterId: "char-mara", wardrobe: "nude", mode: "between" }],
      },
    });
    const scenes = [scene(2, "He watches as she climaxes.")];

    expect(wardrobeContradictions(watched, scenes, [MARA, DANE])).toEqual([]);
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

/**
 * A model writing the wardrobe timeline says where the clothes went: "nude,
 * black lace bra and panties pooled on marble tile behind her". Only a bare
 * "nude" was recognised, so this read as an outfit and every render was told
 * she "is dressed in nude, black lace bra and panties…".
 */
describe("a nude state with detail after it", () => {
  const POOLED = "nude, black lace bra and panties pooled on marble tile behind her";
  const TOWEL = "nude, white towel wrapped around shoulders and arms across her chest";
  const SARA: Character = { ...MARA, id: "char-sara", name: "Sara" };

  it("is read as nude, with the detail kept", () => {
    expect(nudeWithDetail(POOLED)).toBe("black lace bra and panties pooled on marble tile behind her");
    expect(isNudeState(TOWEL)).toBe(true);
    expect(nudeWithDetail("nude")).toBeUndefined();
    expect(isNudeState("nude slip dress, gold heels")).toBe(false);
    expect(isNudeState("black silk robe, open")).toBe(false);
  });

  it("is never phrased as something she is dressed in", () => {
    expect(wardrobeSentence("Sara", POOLED)).toBe(
      "Sara is nude; black lace bra and panties pooled on marble tile behind her.",
    );
    expect(wardrobeSentence("Sara", "nude")).toBe("Sara is completely naked with no clothing.");
    expect(wardrobeSentence("Sara", "white polo shirt")).toBe("Sara is dressed in white polo shirt.");

    const body = "Medium shot, eye level. Sara, a woman in her fifties, stands in the shower.";
    const suffix = castPromptSuffix([SARA], { "char-sara": TOWEL }, {}, body);
    expect(suffix).not.toMatch(/dressed in/i);
    expect(suffix).toContain("nude; white towel wrapped around shoulders");
  });

  it("is not appended again when the prompt already says it", () => {
    const body =
      "Medium shot, eye level. Sara, a woman in her fifties, stands nude by the shower. " +
      "Her black lace bra and panties are pooled on marble tile behind her.";
    expect(castPromptSuffix([SARA], { "char-sara": POOLED }, {}, body)).not.toContain("Wardrobe continuity");
  });

  it("is not flagged as a wardrobe conflict once phrased that way", () => {
    const prompt = `Close-up, eye level. Sara stands nude in the shower. Wardrobe continuity — ${wardrobeSentence("Sara", POOLED)}`;
    expect(wardrobeConflicts(prompt, { Sara: POOLED })).toEqual([]);
  });
});

/** Clothes lying on the floor are props in the frame, not an outfit somebody wears. */
describe("garments that are off the body", () => {
  it("are not counted as invented clothing", () => {
    const prompt = "Sara stands nude under the water. Her black lace bra and panties are pooled on the tile behind her.";
    expect(inventedGarments(prompt, "nude")).toEqual([]);
  });

  it("still count when the same clause says they are worn", () => {
    expect(inventedGarments("Sara is wearing a bra, her robe dropped on the floor.", "nude")).toContain("bra");
    expect(inventedGarments("Sara stands in a white shirt.", "nude")).toContain("shirt");
  });
});
