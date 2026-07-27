import { describe, it, expect } from "vitest";
import {
  createProject,
  generateArtDirectionPlan,
  generateCinematographyPlan,
  generateDirectorialPlan,
  generateStoryboard,
  generateWorldBible,
} from "@/lib/services/project-service";
import { sceneCreativeSlice, globalStyleSuffix } from "@/lib/agents/creative-context";

/**
 * The Agentic Canvas plans used to be write-only: stored, displayed, and never
 * read back. These tests pin the wiring so a refactor cannot quietly sever it
 * again.
 */
describe("agentic canvas plans reach the render prompts", () => {
  it("slices per-scene entries by number, id, and label", () => {
    const plans = {
      directorialPlan: {
        projectId: "p",
        creativeThesis: "",
        pacingStrategy: "",
        emotionalArc: [],
        performanceDirection: [],
        sceneIntent: { "2": "Hold on the hesitation." },
        approvalNotes: [],
      },
      cinematographyPlan: {
        projectId: "p",
        cameraLanguage: "",
        lensAndFramingRules: [],
        movementRules: [],
        lightingRules: [],
        sceneShotPlans: { "Scene 2": "Locked-off wide." },
        transitionLanguage: [],
      },
    };

    const slice = sceneCreativeSlice(plans, { id: "scene-2", sceneNumber: 2 });
    expect(slice.intent).toBe("Hold on the hesitation.");
    expect(slice.shotPlan).toBe("Locked-off wide.");

    // A scene with no plan entry must not inherit another scene's direction.
    expect(sceneCreativeSlice(plans, { id: "scene-9", sceneNumber: 9 })).toEqual({
      intent: undefined,
      shotPlan: undefined,
    });
  });

  it("emits nothing when no plans exist, so prompts stay unchanged", () => {
    expect(globalStyleSuffix(undefined)).toBe("");
    expect(globalStyleSuffix({})).toBe("");
  });

  it("carries directorial intent and art direction into every scene prompt", async () => {
    const project = await createProject({
      concept: "A lighthouse keeper waits out a storm.",
      requestedDurationSeconds: 40,
    });

    await generateWorldBible(project.id);
    await generateDirectorialPlan(project.id);
    await generateCinematographyPlan(project.id);
    await generateArtDirectionPlan(project.id);

    const record = await generateStoryboard(project.id);
    const scenes = record.storyboard!.scenes;
    expect(scenes.length).toBeGreaterThan(0);

    for (const scene of scenes) {
      expect(scene.prompts.videoPromptSegment).toContain("Scene intent:");
      expect(scene.prompts.videoPromptSegment).toContain("Shot plan:");
      expect(scene.prompts.startFramePrompt).toContain("Art direction:");
      expect(scene.prompts.endFramePrompt).toContain("Art direction:");
      expect(scene.prompts.promptQualityChecklist).toContain("directorial intent applied");
      expect(scene.prompts.promptQualityChecklist).toContain("cinematography shot plan applied");
    }

    // The World Bible's forbidden contradictions become negative-prompt terms.
    expect(scenes[0]!.prompts.videoNegativePrompt).toContain("No unexplained changes");
    // Scene cards take their objective and camera from the approved plans.
    expect(scenes[0]!.sceneObjective).toContain("Intent for scene 1");
    expect(scenes[0]!.cameraMovement).toContain("lateral tracking");
  });

  it("leaves prompts plan-free when the canvas agents have not been run", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 40,
    });

    const record = await generateStoryboard(project.id);
    for (const scene of record.storyboard!.scenes) {
      expect(scene.prompts.videoPromptSegment).not.toContain("Scene intent:");
      expect(scene.prompts.startFramePrompt).not.toContain("Art direction:");
      expect(scene.prompts.videoNegativePrompt).toBe(
        "no flicker, no warping, no duplicated subjects, no abrupt cuts",
      );
    }
  });
});
