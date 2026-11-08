import { describe, expect, it } from "vitest";
import {
  complexionOf,
  complexionPhrase,
  conveysComplexion,
  identityAnchors,
  missingComplexion,
  withComplexionBesideName,
} from "@/lib/agents/identity";
import { castPromptSuffix, describesAppearance, storyCharacters, storyIdentity } from "@/lib/agents/cast";
import { composeFrameCast, rebuiltPrompts, sheetIsStale } from "@/lib/agents/cast-sheet";
import { identityWarnings } from "@/lib/agents/prompt-validation";
import type { Character } from "@/lib/schemas/character";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * A live project's lead was a heavyset Black man the planning agents
 * introduced — a story character, with no library entry. Library characters
 * have always had their description appended when a prompt left it out; he had
 * nothing. Prompts described him by build, age and gut, every check passed, and
 * he rendered white in scene after scene until the prompts were fixed by hand.
 */

const LEROY =
  "Heavyset Black man in his mid-fifties with thick gut showing visible belly roll, broad chest " +
  "with folds, uncut cock (soft and drooping at start, hard and shiny by spooning phase, throbbing " +
  "and cum-streaked at finish); wears nothing \u2014 bare-skinned naked throughout segments 1\u201350; " +
  "dark espresso-brown skin reads thick and soft under hard light";

const TLB: Character = {
  id: "c-1",
  name: "TLBr3f",
  description:
    "woman, middle-aged blonde woman, blue eyes, layered shoulder-length hair, natural skin " +
    "texture, medium sized breasts",
} as Character;

const bible = {
  characters: [
    { name: "TLBr3f", description: TLB.description },
    { name: "Leroy", description: LEROY },
  ],
};

describe("reading a complexion from a description", () => {
  it("takes both the ethnicity and the skin tone, in the description's words", () => {
    const complexion = complexionOf(LEROY);
    expect(complexion.ethnicity).toBe("Black");
    expect(complexion.personNoun).toBe("man");
    expect(complexion.skin).toBe("dark espresso-brown skin");
    expect(complexionPhrase(complexion)).toBe("a Black man with dark espresso-brown skin");
  });

  it("does not read skin texture, hair or clothing as a complexion", () => {
    expect(complexionOf(TLB.description)).toEqual({ colours: [] });
    expect(complexionOf("black-haired woman in a black lace bra").ethnicity).toBeUndefined();
    expect(complexionOf("Black hair, white linen shirt").ethnicity).toBeUndefined();
    expect(complexionOf("bare-skinned and naked").skin).toBeUndefined();
  });

  it("recognises the common shapes", () => {
    expect(complexionOf("an olive-skinned woman").skin).toBe("olive-skinned");
    expect(complexionOf("a tall East Asian man").ethnicity).toBe("East Asian");
    expect(complexionPhrase(complexionOf("a woman with pale freckled skin"))).toBe("with pale freckled skin");
  });

  it("accepts a paraphrase as stating it", () => {
    const complexion = complexionOf(LEROY);
    expect(conveysComplexion("Leroy, a heavyset Black man, kneels", complexion)).toBe(true);
    expect(conveysComplexion("Leroy, dark-skinned and heavyset, kneels", complexion)).toBe(true);
    expect(conveysComplexion("Leroy, heavyset with a thick gut, kneels", complexion)).toBe(false);
  });

  /** Live prompts said it this way, and the first version of the check called them missing. */
  it("accepts the description's colour on a body part, but not on hair or a prop", () => {
    const complexion = complexionOf(LEROY);
    expect(conveysComplexion("Leroy's espresso-brown hands grip her hips", complexion)).toBe(true);
    expect(conveysComplexion("Leroy's heavyset espresso-brown belly presses close", complexion)).toBe(true);
    expect(conveysComplexion("Leroy grips the dark brown headboard", complexion)).toBe(false);
    expect(conveysComplexion("Leroy, with dark brown hair, kneels", complexion)).toBe(false);
  });
});

describe("a story character's identity", () => {
  it("keeps the traits and drops wardrobe, future states and lighting", () => {
    const identity = storyIdentity(LEROY);
    expect(identity).toContain("Heavyset Black man in his mid-fifties");
    expect(identity).toContain("dark espresso-brown skin");
    expect(identity).not.toMatch(/wears nothing|naked|segments|drooping|at finish|hard light/);
  });

  it("lists only people the library does not pin", () => {
    expect(storyCharacters(bible, [TLB]).map((person) => person.name)).toEqual(["Leroy"]);
  });
});

describe("composing a keyframe prompt", () => {
  const story = storyCharacters(bible, [TLB]);
  const compose = (body: string, visible = ["TLBr3f", "Leroy"]) =>
    composeFrameCast({ body, cast: [TLB], options: {}, story, visible, others: {} });

  it("appends a story character's identity when the prompt only names him", () => {
    const prompt = compose("Medium shot. TLBr3f lies on the bed while Leroy kneels at its foot.");
    expect(prompt).toContain("Character continuity");
    expect(prompt).toMatch(/Leroy: Heavyset Black man[^.]*dark espresso-brown skin/);
  });

  it("puts the complexion beside his name when the prompt describes him without it", () => {
    const body =
      "Medium shot. Leroy, heavyset in his mid-fifties with a thick gut and broad chest, kneels " +
      "between TLBr3f's thighs.";
    expect(describesAppearance(body, "Leroy", storyIdentity(LEROY), 2)).toBe(true);
    const prompt = compose(body);
    expect(prompt).toContain("Leroy (a Black man with dark espresso-brown skin), heavyset");
    // Said once: no second full description to render him twice.
    expect(prompt).not.toContain("Leroy: Heavyset");
  });

  it("leaves a prompt that already states it alone", () => {
    const body =
      "Medium shot. Leroy, a heavyset Black man in his mid-fifties with dark espresso-brown skin " +
      "and a thick gut, kneels between TLBr3f's thighs.";
    expect(compose(body)).not.toContain("(a Black man");
    expect(compose(body)).not.toContain("Leroy: Heavyset");
  });

  it("skips a possessive and uses the first plain mention", () => {
    const body = "Close-up. Leroy's thick hand grips her thigh. Leroy, heavyset in his mid-fifties " +
      "with a thick gut and broad chest, leans in.";
    expect(withComplexionBesideName(body, "Leroy", complexionOf(LEROY)))
      .toContain("Leroy (a Black man with dark espresso-brown skin), heavyset");
  });

  /** Scenes 22 and 23 of the live project mentioned him only as "Leroy's". */
  it("carries the complexion in the sheet when every mention is possessive", () => {
    const body = "Medium shot. Both of TLBr3f's hands clasp Leroy's thick bare forearm while Leroy's " +
      "heavyset gut and broad chest press close in his mid-fifties.";
    const prompt = compose(body);
    expect(prompt.startsWith(body)).toBe(true);
    expect(prompt).toContain("Leroy: a Black man with dark espresso-brown skin.");
    expect(identityWarnings(prompt, "start", {
      scene: { frameVisibility: { start: ["Leroy"], end: [] } }, participants: [], explicit: false,
      identities: identityAnchors([{ name: "Leroy", description: LEROY }]),
    } as never)).toEqual([]);
  });

  it("says nothing about someone the frame does not show", () => {
    const prompt = compose("Close-up of TLBr3f on the pillow; Leroy is out of frame.", ["TLBr3f"]);
    expect(prompt).not.toContain("Leroy:");
    expect(prompt).not.toContain("(a Black man");
  });

  it("is idempotent, so the stored-prompt rebuild finds nothing stale afterwards", () => {
    const once = compose("Medium shot. TLBr3f lies on the bed while Leroy kneels at its foot.");
    const body = once.slice(0, once.indexOf(" Character continuity"));
    expect(compose(body)).toBe(once);
  });

  it("keeps a library character's skin tone when the sheet trims her description", () => {
    const long: Character = {
      id: "c-2",
      name: "Ana",
      description:
        "A woman in her forties with a long oval face, high cheekbones, arched brows, a small " +
        "scar above the left eyebrow, shoulder-length wavy chestnut hair, silver hoop earrings, a " +
        "thin gold chain, painted red nails, a slim athletic build from years of running, and " +
        "warm olive skin",
    } as Character;
    expect(castPromptSuffix([long, TLB, { ...TLB, id: "c-3", name: "Mia" }])).toContain("warm olive skin");
  });
});

describe("rebuilding stored prompts", () => {
  const scene = {
    id: "s1",
    sceneNumber: 1,
    charactersPresent: ["TLBr3f"],
    frameVisibility: { start: ["TLBr3f", "Leroy"], end: ["TLBr3f", "Leroy"] },
    subjectFaceVisible: true,
    actionDescription: "",
    visualDescription: "",
    prompts: {
      startFramePrompt: "Medium shot. TLBr3f lies back while Leroy kneels at the foot of the bed.",
      endFramePrompt: "Medium shot. Leroy, a heavyset Black man, kneels close.",
      videoPromptSegment: "Leroy leans in.",
      imageNegativePrompt: "",
      videoNegativePrompt: "",
      promptQualityChecklist: [],
    },
  } as unknown as Scene;

  it("offers the repair for a project written before story characters had a sheet", () => {
    expect(sheetIsStale(scene, [TLB], undefined, bible)).toBe(true);
    const rebuilt = rebuiltPrompts(scene, [TLB], undefined, bible);
    expect(rebuilt.startFramePrompt).toMatch(/Leroy: Heavyset Black man/);
    expect(rebuilt.endFramePrompt).not.toContain("Leroy: Heavyset");
    expect(sheetIsStale({ ...scene, prompts: { ...scene.prompts, ...rebuilt } }, [TLB], undefined, bible))
      .toBe(false);
  });

  it("is unchanged for a caller that supplies no visual bible", () => {
    expect(rebuiltPrompts(scene, [TLB], undefined).startFramePrompt).not.toContain("Leroy:");
  });
});

describe("the identity_missing warning", () => {
  const identities = identityAnchors([TLB, { name: "Leroy", description: LEROY }]);
  const context = {
    scene: { frameVisibility: { start: ["TLBr3f", "Leroy"], end: ["TLBr3f"] } },
    participants: [],
    explicit: false,
    identities,
  } as never;

  it("flags a frame that names him without his skin tone", () => {
    expect(identityWarnings("Leroy, heavyset and in his fifties, kneels.", "start", context))
      .toEqual(["start: identity_missing (Leroy)"]);
  });

  it("is quiet when the frame states it, or does not show him", () => {
    expect(identityWarnings("Leroy, a Black man, kneels.", "start", context)).toEqual([]);
    expect(identityWarnings("Leroy kneels.", "end", context)).toEqual([]);
  });

  it("never asks it of someone whose description gives none", () => {
    expect(missingComplexion("TLBr3f lies back.", identities)).toEqual([]);
  });
});

/** Found in review, each reproduced before it was fixed. */
describe("composition edge cases", () => {
  const story = storyCharacters(bible, [TLB]);

  it("leaves a structured (JSON) prompt exactly as it was", () => {
    const json = '{"short_description": "Leroy kneels at the foot of the bed.", "objects": []}';
    const scene = {
      id: "s1", sceneNumber: 1, charactersPresent: [], subjectFaceVisible: true,
      frameVisibility: { start: ["Leroy"], end: ["Leroy"] },
      prompts: { startFramePrompt: json, endFramePrompt: json, videoPromptSegment: "" },
    } as unknown as Scene;
    expect(rebuiltPrompts(scene, [], undefined, bible).startFramePrompt).toBe(json);
    expect(sheetIsStale(scene, [], undefined, bible)).toBe(false);
  });

  /** "pale-skinned" earlier in the sentence hid the inserted phrase, so each rebuild added another. */
  it("is idempotent when someone else's skin is described first", () => {
    const anna = { name: "Leroy", identity: "a heavyset man in his fifties with a thick gut, dark brown skin" };
    const body = "Medium shot. Anna, pale-skinned and slender, kisses Leroy, a heavyset man in his fifties with a thick gut.";
    const compose = (text: string) =>
      composeFrameCast({ body: text, cast: [], options: {}, story: [anna], visible: ["Leroy"], others: {} });
    const once = compose(body);
    expect(once.match(/\(with dark brown skin\)/g)).toHaveLength(1);
    expect(compose(once)).toBe(once);
  });

  it("never edits quoted dialogue, and reads a name as a proper noun", () => {
    const leroy = complexionOf(LEROY);
    expect(withComplexionBesideName('"Leroy, come here," she whispers as Leroy, heavyset, kneels.', "Leroy", leroy))
      .toBe('"Leroy, come here," she whispers as Leroy (a Black man with dark espresso-brown skin), heavyset, kneels.');
    const rose = complexionOf("a Black woman with dark skin");
    expect(withComplexionBesideName("The sun rose over the bay as Rose walks in.", "Rose", rose))
      .toBe("The sun rose over the bay as Rose (a Black woman with dark skin) walks in.");
  });

  /** With a story character in the frame too, the two decisions used different budgets. */
  it("never leaves a library character with neither an inline skin tone nor a sheet", () => {
    const leroy: Character = {
      id: "c-l", name: "Leroy",
      description: "Heavyset Black man in his mid-fifties with stubble, a gold chain, a thick gut and dark espresso-brown skin",
    } as Character;
    const sam: Character = { id: "c-s", name: "Sam", description: "Slim young man with red hair and freckles" } as Character;
    const marco = { name: "Marco", identity: "A tall man with a shaved head" };
    const prompt = composeFrameCast({
      body: "Wide shot. Leroy, heavyset, stubble, gold chain, takes a deliberate walk past Sam and Marco.",
      cast: [leroy, sam], options: {}, story: [marco], visible: ["Leroy", "Sam", "Marco"], others: {},
    });
    expect(missingComplexion(prompt, identityAnchors([leroy]))).toEqual([]);
  });
});
