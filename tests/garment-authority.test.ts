import { describe, expect, it } from "vitest";

import { inventedGarments, withoutInventedGarments } from "@/lib/agents/prompt-gate";
import { establishedGarments } from "@/lib/agents/prompt-agents";
import type { Character } from "@/lib/schemas/character";

// What the visual bible says the two unpinned men wear. Neither is in the
// character library, so before the bible was consulted their clothes were
// invented by definition and every frame stripped them.
const BIBLE =
  "her husband wearing an unbuttoned charcoal-grey dress shirt with sleeves rolled to " +
  "mid-forearm and dark slacks. a server in a hotel uniform of a crisp white long-sleeve " +
  "shirt and pressed black trousers.";

const PINNED = "black satin lingerie with a low-cut neckline and matching panties";

describe("who is allowed to be wearing something", () => {
  const pinned = [{ id: "char-1", name: "Mara" } as Character];

  it("counts an outfit the visual bible gave an unpinned character", () => {
    const established = establishedGarments({ "char-1": PINNED }, undefined, pinned, [
      { description: "Her husband, wearing a charcoal-grey dress shirt and dark slacks." },
    ]);
    expect(established).toContain("slacks");
  });

  it("still counts the pinned wardrobe", () => {
    const established = establishedGarments({ "char-1": PINNED }, undefined, pinned, []);
    expect(established).toContain("lingerie");
  });

  it("ignores a pinned outfit for someone who is not in this scene", () => {
    const established = establishedGarments({ "char-9": PINNED }, undefined, pinned, []);
    expect(established).not.toContain("lingerie");
  });
});

describe("clothing the project specified is not clothing the model invented", () => {
  it("leaves an unpinned character in the outfit the visual bible gave him", () => {
    const prompt =
      "Dane, wearing an unbuttoned charcoal-grey dress shirt and dark slacks, sits on the bed.";
    expect(withoutInventedGarments(prompt, `${PINNED} ${BIBLE}`)).toBe(prompt);
  });

  it("leaves the server in his uniform", () => {
    const prompt =
      "The server stands at the threshold wearing a crisp white long-sleeve shirt and pressed black trousers.";
    expect(withoutInventedGarments(prompt, `${PINNED} ${BIBLE}`)).toBe(prompt);
  });

  it("undresses him when only the pinned wardrobe is known, which is the bug", () => {
    // Pinned against the old behaviour so the regression stays visible. This is
    // what shipped: an unpinned husband, correctly dressed by the model from the
    // bible, rewritten to "naked" in nine consecutive scenes.
    const prompt = "Dane, wearing an unbuttoned charcoal-grey dress shirt, sits on the bed.";
    expect(withoutInventedGarments(prompt, PINNED)).toContain("naked");
  });

  it("still strips an outfit nobody specified", () => {
    const prompt = "The man kneels wearing black silk trousers and a leather corset.";
    expect(withoutInventedGarments(prompt, `${PINNED} ${BIBLE}`)).toContain("naked");
  });

  it("reports only the garments no authority named", () => {
    const prompt = "Dane in dark slacks beside a woman in a leather corset.";
    const found = inventedGarments(prompt, `${PINNED} ${BIBLE}`);
    expect(found).not.toContain("slacks");
    expect(found).toContain("corset");
  });
});
