import { describe, it, expect } from "vitest";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import { visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { castNegativeSuffix, castPromptSuffix, castSystemDirective } from "@/lib/agents/cast";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";

function makeProject(): Project {
  const seg = computeSegmentation(40);
  const now = new Date().toISOString();
  return {
    id: "cast-project",
    title: "Cast Project",
    concept: "A woman walks out into a storm.",
    requestedDurationSeconds: 40,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "tense",
    audience: "adults",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: true,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    useCharacterLibrary: true,
    characterIds: ["char-1"],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

const ELENA: Character = {
  id: "char-1",
  name: "Elena",
  description:
    "A woman in her mid-thirties, tall and lean, with shoulder-length dark curly hair and olive skin.",
  negativePrompt: "no glasses, not elderly",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("character library cast injection", () => {
  it("builds prompt fragments only when a cast is pinned", () => {
    expect(castPromptSuffix([])).toBe("");
    expect(castNegativeSuffix([])).toBe("");
    expect(castSystemDirective([])).toBe("");

    expect(castPromptSuffix([ELENA])).toContain("Elena: A woman in her mid-thirties");
    expect(castNegativeSuffix([ELENA])).toBe(", no glasses, not elderly");
    expect(castSystemDirective([ELENA])).toContain("locked");
  });

  it("pins the cast into the visual bible ahead of any invented characters", async () => {
    const bible = await visualBibleAgent({ project: makeProject(), cast: [ELENA] }, null);
    expect(bible.characters[0]).toEqual({ name: ELENA.name, description: ELENA.description });
  });

  it("carries the description and negative terms into every scene prompt", async () => {
    const snapshot = await runStoryboardOrchestrator(makeProject(), {
      provider: null,
      cast: [ELENA],
    });

    expect(snapshot.scenes.length).toBeGreaterThan(0);
    for (const scene of snapshot.scenes) {
      expect(scene.prompts.startFramePrompt).toContain(ELENA.description);
      expect(scene.prompts.endFramePrompt).toContain(ELENA.description);
      // The clip renders from the start frame, which already fixes the face and
      // wardrobe, so the video prompt gets the name and a preservation clause
      // instead of a second copy of the description competing with the motion.
      expect(scene.prompts.videoPromptSegment).not.toContain(ELENA.description);
      expect(scene.prompts.videoPromptSegment).toContain("The start frame fixes how Elena look");
      // The character's exclusions arrive as terms, the negation stripped.
      expect(scene.prompts.imageNegativePrompt).toContain("glasses");
      expect(scene.prompts.imageNegativePrompt).not.toContain("no glasses");
      expect(scene.prompts.videoNegativePrompt).toContain("elderly");
    }
    // Scene cards should name the character rather than an anonymous subject.
    expect(snapshot.scenes[0]!.actionDescription).toContain("Elena");
    expect(snapshot.scenes[0]!.dialogue?.[0]?.character).toBe("Elena");
  });

  it("leaves prompts untouched when no cast is pinned", async () => {
    const snapshot = await runStoryboardOrchestrator(makeProject(), { provider: null });
    for (const scene of snapshot.scenes) {
      expect(scene.prompts.startFramePrompt).not.toContain("Character continuity");
      expect(scene.prompts.videoPromptSegment).not.toContain("The start frame fixes");
      expect(scene.prompts.imageNegativePrompt).toBe(
        "watermark, distorted anatomy, text artifacts, low quality",
      );
    }
  });

  /** Bound into the same clause as the person, so it cannot drift to another body. */
  it("states the wardrobe explicitly so it is not reinvented per render", () => {
    const dressed = { ...ELENA, wardrobe: "a fitted white tank top and black tailored trousers" };
    const sheet = castPromptSuffix([dressed]);
    expect(sheet).toContain(", dressed in a fitted white tank top and black tailored trousers.");
    // Without one, nothing is asserted about clothing rather than something vague.
    expect(castPromptSuffix([ELENA])).not.toContain("dressed in");
  });
});
