import { describe, expect, it } from "vitest";

import { repairImagePrompt } from "@/lib/agents/prompt-gate";
import type { ImageGateContext } from "@/lib/agents/prompt-gate";
import type { SceneDraft } from "@/lib/schemas/storyboard";

const GUARD =
  "Everyone taking part in the act is completely naked; anyone else in frame keeps the clothing described.";

function ctx(): ImageGateContext {
  return {
    scene: {
      id: "p-scene-013",
      actionDescription: "",
      visualDescription: "",
      storyBeat: "",
    } as SceneDraft,
    participants: [],
    explicit: true,
    establishedWardrobe: { start: "nude", end: "nude" },
    wardrobeChange: false,
  } as ImageGateContext;
}

describe("the act guard is stated once", () => {
  it("does not append a sentence the prompt already carries", () => {
    // Live, one scene shipped with the guard twice in the same prompt. A
    // diffusion model weights a repeated sentence twice, which is the opposite
    // of the intent — the same reason every other addition is deduplicated.
    const repaired = repairImagePrompt(
      `Two figures on the chaise. ${GUARD}`,
      "start",
      ["wardrobe_contradicts_act"],
      ctx(),
    );
    expect(repaired.split(GUARD).length - 1).toBe(1);
  });

  it("still adds it when the prompt does not have it", () => {
    const repaired = repairImagePrompt(
      "Two figures on the chaise.",
      "start",
      ["wardrobe_contradicts_act"],
      ctx(),
    );
    expect(repaired).toContain(GUARD);
  });
});
