import { describe, expect, it } from "vitest";
import { outfitsFromBible, wardrobeTimeline } from "@/lib/agents/wardrobe";
import { castPromptSuffix, describedInline } from "@/lib/agents/cast";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";

/**
 * Scene 1 of a live run had no clothes in it, and neither did the men in the
 * patron scenes. A frame that names nobody's clothing, on a prompt that says
 * "explicit content", is drawn bare — and the sheet that would have carried her
 * wardrobe was skipped because a medium wide shot shares "medium", "shoulder"
 * and "skin" with her description.
 */

const TLB: Character = {
  id: "c-1",
  name: "TLBr3f",
  description:
    "woman, middle-aged blonde woman, blue eyes, layered shoulder-length hair, natural skin " +
    "texture, medium sized breasts",
  wardrobe: "matching black lace bra and panties",
} as Character;

const project = (wardrobeChanges: Project["wardrobeChanges"] = {}): Project =>
  ({ id: "p", wardrobeChanges, characterWardrobe: {} }) as Project;

const bible = {
  characters: [
    { name: "TLBr3f", description: TLB.description },
    {
      name: "Large Black Man",
      description:
        "Front-row patron, large build. Wearing a simple unbranded dark t-shirt and dark trousers. " +
        "Seated at bar-height table.",
    },
    { name: "Muscular Asian Man", description: "Front-row patron. Wearing a buttoned shirt." },
  ],
};

describe("what the visual bible says unnamed people wear", () => {
  it("takes a standing outfit for everyone who is not pinned", () => {
    expect(outfitsFromBible(bible, [TLB])).toEqual({
      "Large Black Man": "a simple unbranded dark t-shirt and dark trousers",
      "Muscular Asian Man": "a buttoned shirt",
    });
  });

  it("leaves out a description that walks through a change of clothes", () => {
    const mike = {
      characters: [
        {
          name: "Mike",
          description: "Wearing dark grey sweatpants initially; he removes them by segment 7.",
        },
        { name: "Dan", description: "Wearing a navy suit. He later takes off the jacket." },
      ],
    };
    expect(outfitsFromBible(mike, [])).toEqual({});
  });

  it("leaves out an outfit that is itself nudity", () => {
    expect(
      outfitsFromBible({ characters: [{ name: "A", description: "Wearing nothing but a watch." }] }, []),
    ).toEqual({});
    expect(
      outfitsFromBible({ characters: [{ name: "B", description: "Wearing white boxer briefs, no shirt." }] }, []),
    ).toEqual({});
  });

  it("does not count jewellery or accessories as an outfit", () => {
    expect(
      outfitsFromBible(
        {
          characters: [
            { name: "Ravi", description: "Wearing a gold chain necklace." },
            { name: "Tracey", description: "Wearing small gold hoop earrings." },
            { name: "Marcus", description: "Wearing a black leather wristwatch." },
            { name: "Man C", description: "Wearing a grey henley shirt with a silver chain necklace." },
          ],
        },
        [],
      ),
    ).toEqual({ "Man C": "a grey henley shirt with a silver chain necklace" });
  });

  it("never reads the pinned cast's description as an unnamed person's", () => {
    const withWorn = { characters: [{ name: "TLBr3f", description: "Wearing a red dress." }] };
    expect(outfitsFromBible(withWorn, [TLB])).toEqual({});
  });
});

describe("the timeline for people who are not in the cast", () => {
  const scenes = [1, 2, 3].map((n) => ({
    id: `p-scene-00${n}`,
    visualDescription: "A club.",
    actionDescription: "She dances.",
    continuityNotes: [] as string[],
  }));

  it("dresses them from the first scene, in every scene", () => {
    const timeline = wardrobeTimeline(project(), scenes, [TLB], bible);
    for (const scene of scenes) {
      expect(timeline.get(scene.id)!.othersStart["Large Black Man"]).toBe(
        "a simple unbranded dark t-shirt and dark trousers",
      );
    }
  });

  it("changes nothing when no bible is given", () => {
    expect(wardrobeTimeline(project(), scenes, [TLB]).get("p-scene-001")!.othersStart).toEqual({});
  });

  it("lets the card undress him, and carries it forward", () => {
    const withNude = scenes.map((scene, i) =>
      i === 1
        ? { ...scene, actionDescription: "The large black man is naked as he rises from his seat." }
        : scene,
    );
    const timeline = wardrobeTimeline(project(), withNude, [TLB], bible);
    expect(timeline.get("p-scene-001")!.othersStart["Large Black Man"]).toMatch(/t-shirt/);
    expect(timeline.get("p-scene-002")!.othersStart["Large Black Man"]).toBe("nude");
    expect(timeline.get("p-scene-003")!.othersStart["Large Black Man"]).toBe("nude");
    expect(timeline.get("p-scene-003")!.othersStart["Muscular Asian Man"]).toBe("a buttoned shirt");
  });

  it("does not undress him for a sentence about somebody else", () => {
    const other = scenes.map((scene) => ({
      ...scene,
      actionDescription: "She is naked. The large black man watches from his seat.",
    }));
    expect(
      wardrobeTimeline(project(), other, [TLB], bible).get("p-scene-002")!.othersStart["Large Black Man"],
    ).toMatch(/t-shirt/);
  });

  it("puts a storyboard change on the same man rather than a second label", () => {
    const changed = project({
      "p-scene-002": [
        { subject: "the large black man", wardrobe: "a grey hoodie", mode: "between", origin: "story" },
      ],
    });
    const timeline = wardrobeTimeline(changed, scenes, [TLB], bible);
    expect(Object.keys(timeline.get("p-scene-003")!.othersStart)).toEqual([
      "Large Black Man",
      "Muscular Asian Man",
    ]);
    expect(timeline.get("p-scene-003")!.othersStart["Large Black Man"]).toBe("a grey hoodie");
    expect(timeline.get("p-scene-001")!.othersStart["Large Black Man"]).toMatch(/t-shirt/);
  });
});

describe("a frame that never says what she wears", () => {
  const frame = { faceVisible: true, tightShot: false };
  const dressed = { "c-1": "matching black lace bra and panties" };
  // The live scene 1 body: a medium wide shot, no clothing, no hair colour.
  const body =
    "Medium wide shot, eye level three-quarter front angle. TLBr3f stands far left of frame. " +
    "Her arms hang relaxed at her sides, shoulders square and relaxed. Soft purple and pink neon " +
    "washes over her skin showing natural pores and age-appropriate texture. Her eyes are calm.";

  it("does not count shot sizes and skin words as describing her", () => {
    expect(describedInline(body, TLB, 1)).toBe(false);
    expect(castPromptSuffix([TLB], dressed, frame, body)).toContain("Character continuity");
    expect(castPromptSuffix([TLB], dressed, frame, body)).toContain(
      "dressed in matching black lace bra and panties",
    );
  });

  it("still counts a real description of her", () => {
    const real =
      "Medium shot. TLBr3f, a middle-aged blonde woman with blue eyes and layered hair, stands at the pole.";
    expect(describedInline(real, TLB, 1)).toBe(true);
  });

  it("adds only her wardrobe when the body describes her but not her clothes", () => {
    const real =
      "Medium shot. TLBr3f, a middle-aged blonde woman with blue eyes and layered hair, stands at the pole.";
    expect(castPromptSuffix([TLB], dressed, frame, real)).toBe(
      " Wardrobe continuity — TLBr3f is dressed in matching black lace bra and panties.",
    );
  });

  it("adds nothing when the body already says what she wears", () => {
    const real =
      "Medium shot. TLBr3f, a middle-aged blonde woman with blue eyes and layered hair in a black " +
      "lace bra and panties, stands at the pole.";
    expect(castPromptSuffix([TLB], dressed, frame, real)).toBe("");
  });

  it("says she is bare when the timeline says so and the body does not", () => {
    const real =
      "Medium shot. TLBr3f, a middle-aged blonde woman with blue eyes and layered hair, stands at the pole.";
    expect(castPromptSuffix([TLB], { "c-1": "nude" }, frame, real)).toBe(
      " Wardrobe continuity — TLBr3f is completely naked with no clothing.",
    );
  });
});
