import { describe, expect, it } from "vitest";
import { castWardrobeAfter } from "@/lib/agents/wardrobe";
import { castSystemDirective } from "@/lib/agents/cast";
import { storyboardSystem } from "@/lib/agents/storyboard-agent";
import type { Character } from "@/lib/schemas/character";

const MARA = {
  id: "c-mara",
  name: "Mara",
  description: "A 52-year-old woman.",
  wardrobe: "black lace bra and briefs",
  referenceImagePaths: [],
} as unknown as Character;

const JAIME = {
  id: "c-jaime",
  name: "Jaime",
  description: "A man in his 50s.",
  wardrobe: "blue jeans and a white polo shirt",
  referenceImagePaths: [],
} as unknown as Character;

const change = (character: string, newWardrobe: string, depictedOnScreen = true) => ({
  wardrobeChanges: [{ character, newWardrobe, depictedOnScreen }],
});

describe("castWardrobeAfter", () => {
  it("re-dresses a character from a change declared in an earlier draft", () => {
    const { cast } = castWardrobeAfter([MARA, JAIME], [{}, change("Mara", "nude")]);
    expect(cast.find((c) => c.name === "Mara")!.wardrobe).toBe("nude");
    expect(cast.find((c) => c.name === "Jaime")!.wardrobe).toBe(JAIME.wardrobe);
  });

  it("keeps the last change when a character changes twice", () => {
    const { cast } = castWardrobeAfter(
      [MARA],
      [change("Mara", "nude"), change("Mara", "a white hotel robe")],
    );
    expect(cast[0]!.wardrobe).toBe("a white hotel robe");
  });

  it("matches the cast name regardless of case and surrounding space", () => {
    const { cast } = castWardrobeAfter([MARA], [change("  mara ", "nude")]);
    expect(cast[0]!.wardrobe).toBe("nude");
  });

  it("returns an unnamed subject separately rather than discarding it", () => {
    const { cast, others } = castWardrobeAfter([MARA], [change("the man", "bare-chested")]);
    expect(others).toEqual({ "the man": "bare-chested" });
    expect(cast[0]!.wardrobe).toBe(MARA.wardrobe);
  });

  it("ignores blank subjects and blank outfits", () => {
    const { cast, others } = castWardrobeAfter(
      [MARA],
      [change("Mara", "   "), change("  ", "nude")],
    );
    expect(cast[0]!.wardrobe).toBe(MARA.wardrobe);
    expect(others).toEqual({});
  });

  it("leaves the cast untouched when no change has been declared", () => {
    const { cast, others } = castWardrobeAfter([MARA, JAIME], [{}, {}, {}]);
    expect(cast.map((c) => c.wardrobe)).toEqual([MARA.wardrobe, JAIME.wardrobe]);
    expect(others).toEqual({});
  });
});

describe("wardrobe directives", () => {
  it("routes a costume change to wardrobeChanges and nowhere else", () => {
    const planning = castSystemDirective([MARA]);
    // The prose route is what let a change be narrated where the timeline
    // could not read it, leaving the old outfit appended to every prompt.
    expect(planning).not.toMatch(/narrate it plainly/i);
    expect(planning).toMatch(/until the story changes it/i);
    expect(storyboardSystem(5)).toMatch(/Record a costume change in wardrobeChanges/);
  });

  it("requires the undressed case rather than permitting an empty field", () => {
    const system = storyboardSystem(5);
    expect(system).not.toMatch(/Leave wardrobeChanges empty unless/);
    expect(system).toMatch(/renders with the clothes still on/);
    expect(system).toMatch(/Never describe an intimate act and leave the outfit standing/);
  });
});
