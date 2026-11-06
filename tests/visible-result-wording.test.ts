import { describe, it, expect } from "vitest";
import { revealUnstated, VISIBLE_RESULT_DIRECTIVE } from "@/lib/agents/clothing-wording";
import { storyboardSystem } from "@/lib/agents/storyboard-agent";
import { storyArchitectSystem } from "@/lib/agents/story-architect-agent";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { buildCreativeBrief, buildSceneDrafts, buildStoryPlan, buildVisualBible } from "@/lib/agents/mock-agents";
import { createProject } from "@/lib/services/project-service";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Character } from "@/lib/schemas/character";

/**
 * Saying what the body shows, not only where the garment went.
 *
 * Live, scene 1's arc beat, director intent, card, wardrobe and edit prompt all
 * said "the cups falling loose into her lap… the fabric hangs against her
 * chest" for a woman standing at a shower door. Nothing ever said she was
 * topless, and the edited end frame kept the bra over her chest.
 */

describe("spotting a wardrobe that moves clothing without saying what is bare", () => {
  it("flags the live scene-1 state", () => {
    expect(revealUnstated(
      "black lace bra hanging loose from arms with cups gathered in lap, matching black lace panties still on hips",
    )).toBe(true);
    expect(revealUnstated("white shirt unbuttoned and pulled open")).toBe(true);
    expect(revealUnstated("silk robe slipped off her shoulders")).toBe(true);
  });

  it("accepts a state that says what is uncovered", () => {
    expect(revealUnstated("topless, black lace bra hanging from her wrists, black lace panties")).toBe(false);
    expect(revealUnstated("bare-chested, shirt on the floor, dark jeans")).toBe(false);
    expect(revealUnstated("nude, black lace bra and panties pooled on the tile")).toBe(false);
  });

  it("leaves ordinary clothing alone", () => {
    expect(revealUnstated("white open-collared shirt and navy chinos")).toBe(false);
    expect(revealUnstated("matching black lace panties and bra")).toBe(false);
    expect(revealUnstated("black jeans hanging low on his hips")).toBe(false);
    expect(revealUnstated(undefined)).toBe(false);
  });
});

describe("telling every stage to state the visible result", () => {
  it("reaches the arc and storyboard writers", () => {
    expect(storyArchitectSystem(20, 15)).toContain(VISIBLE_RESULT_DIRECTIVE);
    expect(storyboardSystem(20)).toContain(VISIBLE_RESULT_DIRECTIVE);
    expect(storyboardSystem(20)).toMatch(/nothing rests in the lap of someone standing/);
  });

  it("reaches the image prompt writer, naming the frame whose wardrobe is vague", async () => {
    const MARA: Character = {
      id: "char-mara", name: "Mara", description: "A woman in her fifties.",
      wardrobe: "black lace bra and panties",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const p = await createProject({
      concept: "Mara undresses at the shower door.",
      requestedDurationSeconds: 20,
      sceneContinuity: "reuse_end_frame",
      generationMode: "keyframes_only",
    });
    const vague = "black lace bra hanging loose from her arms, black lace panties";
    p.characterIds = [MARA.id];
    p.wardrobeChanges = { [`${p.id}-scene-001`]: [{ characterId: MARA.id, wardrobe: vague, mode: "within" }] };
    const bible = buildVisualBible(p);
    const drafts = buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), bible).map((scene) => ({
      ...scene, charactersPresent: ["Mara"], frameVisibility: { start: ["Mara"], end: ["Mara"] },
    }));
    const systems: string[] = [];
    const provider: PlanningProvider = {
      name: "record",
      generateJson: async (system, _user, schema) => {
        systems.push(system);
        return schema.parse({
          startFramePrompt: "Medium shot, eye level. Mara stands at the shower door in black lace bra and panties.",
          endFramePrompt: "Medium shot, eye level. Mara stands topless at the shower door, bra hanging from her wrists.",
          imageNegativePrompt: "watermark",
          endFrameEditPrompt: "Edit the supplied reference frame: Mara lowers the bra so she is topless.",
        });
      },
    };
    await attachScenePrompts(p, drafts, provider, { cast: [MARA], visualBible: bible, passes: ["image"] });

    const image = systems.find((s) => s.startsWith("You are the Image Prompt Agent"))!;
    expect(image).toContain(VISIBLE_RESULT_DIRECTIVE);
    expect(image).toContain(`Mara in the end frame ("${vague}")`);
    expect(image).not.toContain("in the start frame (");
  });
});
