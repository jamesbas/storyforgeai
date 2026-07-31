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

  /**
   * `productionDesign` rides on every image and video prompt and was the only
   * entry here without a bound, so a model that answered at length put a
   * paragraph in front of every render.
   */
  it("caps the production design summary that rides on every prompt", () => {
    const long =
      "A rain-slicked dockside in late autumn. Sodium lamps and wet granite throughout. " +
      "Every surface should read as salt-worn and repaired. The palette leans to bottle green. " +
      "Nothing is new; everything has been mended at least once.";

    const suffix = globalStyleSuffix({
      artDirectionPlan: {
        projectId: "p",
        productionDesign: long,
        wardrobeRules: [],
        propRules: [],
        setDressingRules: [],
      },
    });

    expect(suffix).toContain("A rain-slicked dockside in late autumn.");
    expect(suffix).not.toContain("Nothing is new");
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

    // The World Bible's forbidden contradictions become negative-prompt terms,
    // with the leading negation stripped: a sampler steers away from the whole
    // phrase, so "No unexplained changes" would spend a word saying nothing.
    expect(scenes[0]!.prompts.videoNegativePrompt).toContain(
      "unexplained changes to the subject or world",
    );
    expect(scenes[0]!.prompts.videoNegativePrompt).not.toContain("No unexplained");
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
        "flicker, jitter, warping, duplicated subjects, abrupt cuts, identity drift, " +
          "background deformation, unintended camera movement",
      );
    }
  });
});
