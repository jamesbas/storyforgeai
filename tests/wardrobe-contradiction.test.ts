import { describe, it, expect } from "vitest";
import { gateImagePrompt, repairImagePrompt, withoutInventedGarments } from "@/lib/agents/prompt-gate";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Two defects found in a live 24-scene run, both in the wardrobe repair.
 *
 * 1. The garment stripper only recognised `wearing|dressed in|clad in|clothed
 *    in`. The model wrote "naked with dark slacks and an unbuttoned dress
 *    shirt" — a sentence that undoes itself — and the repair could not see it,
 *    so the gate flagged the scene and shipped it anyway. Eight scenes went out
 *    describing a man as naked and dressed at once.
 *
 * 2. The nudity guard is appended for the whole frame, so a fully-clothed
 *    bystander is declared naked alongside the participants. The same prompt
 *    carried a hotel server "in a crisp white long-sleeve hotel shirt and
 *    pressed black trousers" and then asserted every participant was bare.
 */

/** Verbatim from the shipped prompt, names replaced. */
const SELF_UNDOING =
  "Medium shot, eye level. The man sits on a wooden chair to the left of frame naked with " +
  "dark slacks and an unbuttoned charcoal-grey dress shirt sleeves rolled to mid-forearm. " +
  "Beside him kneels Mara, naked. He has his cock (penis) fully inserted deep into her " +
  "pussy (vagina), her hips gripped in both his hands.";

const scene = {
  id: "p-scene-005",
  sceneNumber: 5,
  title: "The Chair",
  actionDescription:
    "Mara kneels and takes him into her mouth while he sits back in the chair, naked.",
  storyBeat: "She undresses and kneels.",
  visualDescription: "A hotel room at night.",
  charactersPresent: [],
} as unknown as Scene;

const ctx = { scene, explicit: true, participants: [] } as unknown as Parameters<
  typeof gateImagePrompt
>[2];

describe("a prompt that calls someone naked and then dresses them", () => {
  it("is caught by the gate", () => {
    expect(gateImagePrompt(SELF_UNDOING, "start", ctx)).toContain("wardrobe_contradicts_act");
  });

  /** The defect: the stripper saw no `wearing`, so it changed nothing. */
  it("has the contradicting garments taken off", () => {
    const stripped = withoutInventedGarments(SELF_UNDOING, "");

    expect(stripped).not.toMatch(/slacks|dress shirt/i);
    expect(stripped).toContain("to the left of frame naked.");
  });

  it("still strips the form it always handled", () => {
    const worn = "He sits in the chair wearing dark slacks and a charcoal shirt.";
    expect(withoutInventedGarments(worn, "")).toBe("He sits in the chair naked.");
  });

  it("leaves an outfit the scene's wardrobe established", () => {
    const dressed = "Mara, naked with a short black silk robe open at the front, stands there.";
    expect(withoutInventedGarments(dressed, "short black silk robe")).toBe(dressed);
  });

  /** "naked with" is only a contradiction when clothing follows it. */
  it("leaves a nudity word followed by something that is not clothing", () => {
    const fine = "She lies back naked with her hair spread across the pillow.";
    expect(withoutInventedGarments(fine, "")).toBe(fine);
  });

  it("repairs the shipped prompt without leaving the contradiction", () => {
    const codes = gateImagePrompt(SELF_UNDOING, "start", ctx);
    const repaired = repairImagePrompt(SELF_UNDOING, "start", codes, ctx);

    expect(repaired).not.toMatch(/slacks|dress shirt/i);
  });
});

/**
 * A room with an onlooker in it.
 *
 * The shipped frame had a hotel server standing at the edge, fully dressed and
 * carrying a tray, while two people on the other side of the room were mid-act.
 * The repair appended "Every participant is completely naked" for the whole
 * frame, so the server was undressed by a sentence written about somebody else.
 */
const WITH_BYSTANDER =
  "Medium wide shot, eye level. The man sits on a wooden chair naked with dark slacks. " +
  "Mara kneels between his knees, naked, his cock (penis) deep in her mouth, her lips " +
  "sealed around the shaft. Standing to the right is a hotel server in a crisp white " +
  "long-sleeve hotel shirt and pressed black trousers holding a folding tray.";

describe("a clothed onlooker beside an act", () => {
  /** The risk in teaching the stripper a new form: it undresses the wrong man. */
  it("keeps the onlooker's clothes, which no nudity word introduced", () => {
    const stripped = withoutInventedGarments(WITH_BYSTANDER, "");

    expect(stripped).toContain("crisp white long-sleeve hotel shirt and pressed black trousers");
    // The participant's self-undoing clause still goes.
    expect(stripped).not.toMatch(/naked with dark slacks/i);
  });

  it("no longer declares the whole frame naked", () => {
    const codes = gateImagePrompt(WITH_BYSTANDER, "start", ctx);
    const repaired = repairImagePrompt(WITH_BYSTANDER, "start", codes, ctx);

    expect(repaired).not.toContain("Every participant is completely naked");
    expect(repaired).toContain("crisp white long-sleeve hotel shirt");
  });

  it("scopes the nudity to the people in the act", () => {
    const codes = gateImagePrompt(WITH_BYSTANDER, "start", ctx);
    const repaired = repairImagePrompt(WITH_BYSTANDER, "start", codes, ctx);

    expect(repaired).toMatch(/taking part in the act (?:is|are) completely naked/i);
  });
});
