import { describe, expect, it } from "vitest";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildImagePrompts,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { describesMotion, stillStates, stripMotion } from "@/lib/agents/still-frame";
import { gateImagePrompt } from "@/lib/agents/prompt-gate";
import { createProject } from "@/lib/services/project-service";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * A keyframe is one held instant. A live run on a 9B planning model shipped
 * "begins her pole walk", "slow rhythmic control" and "tracking movement" in
 * both frames, and 13 of 17 scenes fell back to a template that pasted the
 * clip's whole narrated action into the opening and closing frame alike.
 */

const POLE_ACTION =
  "TLBr3f completes one full circle around the pole with hands gripping at chest height. " +
  "She initiates a deep Body Roll motion pushing upward along the chrome pole surface, hips " +
  "tracing a slow circular arc as she pulls herself higher. Her legs remain extended forward " +
  "while her torso and hips rotate around the pole circumference until she settles into a " +
  "seated position with thighs wrapped around the lower bar section.";

describe("still states from a narrated action", () => {
  it("opens on the first sentence and closes on what the action settles on", () => {
    const { start, end } = stillStates(POLE_ACTION);
    expect(start).toBe(
      "TLBr3f completes one full circle around the pole with hands gripping at chest height",
    );
    expect(end).toBe(
      "She settles into a seated position with thighs wrapped around the lower bar section",
    );
  });

  it("splits a single sentence at the point it resolves", () => {
    expect(stillStates("Mara carries the mug across the room until she stands at the window.")).toEqual({
      start: "Mara carries the mug across the room",
      end: "She stands at the window",
    });
  });

  it("gives both frames the one pose when nothing separates them", () => {
    const states = stillStates("Mara holds the red mug at the desk.");
    expect(states.start).toBe(states.end);
  });

  it("is empty for a card with no action", () => {
    expect(stillStates(undefined)).toEqual({ start: "", end: "" });
    expect(stillStates("")).toEqual({ start: "", end: "" });
  });

  it("never carries a camera move or a duration into a frame", () => {
    const { start, end } = stillStates(
      "Over eight seconds Mara lifts the mug to the window. Camera pushes in slowly on her face. " +
        "Slow push-in as she turns, until the mug rests on the sill.",
    );
    expect(`${start} ${end}`).not.toMatch(/push|camera|seconds/i);
  });
});

describe("removing what a still cannot show", () => {
  it("drops a sentence about the camera whole", () => {
    expect(stripMotion("Mara stands at the window. The camera tilts up her body slowly.")).toBe(
      "Mara stands at the window.",
    );
  });

  it("takes a stated duration out of a sentence without losing the sentence", () => {
    expect(stripMotion("Over eight seconds Mara lifts the red mug to the window.")).toBe(
      "Mara lifts the red mug to the window.",
    );
  });

  it("drops only the clause carrying rhythm", () => {
    expect(
      stripMotion("Mara stands at the window, her hips swaying in a rhythmic motion, holding the red mug."),
    ).toBe("Mara stands at the window, holding the red mug.");
  });

  it("leaves a pose and quoted speech alone", () => {
    const text = 'Mara stands at the window holding the red mug. Mara says, "Over eight seconds, wait."';
    expect(stripMotion(text)).toBe(text);
  });
});

describe("detecting motion in a still", () => {
  it.each([
    "She begins her pole walk around the central pole.",
    "Her hips sway in slow rhythmic control.",
    "Medium wide shot tracking movement around the pole.",
    "She continues her walk toward the window.",
  ])("flags %s", (text) => {
    expect(describesMotion(text)).toBe(true);
  });

  it("passes a held pose", () => {
    expect(
      describesMotion("She grips the pole with both hands at hip height, her weight on her left foot."),
    ).toBe(false);
  });
});

function fixture() {
  return createProject({
    concept: "A dancer performs a pole routine at a club.",
    requestedDurationSeconds: 40,
  }).then((project) => {
    const drafts = buildSceneDrafts(
      project, buildStoryPlan(project), buildCreativeBrief(project), buildVisualBible(project),
    ).map((draft) => ({
      ...draft,
      visualDescription: "Medium wide shot, eye level. TLBr3f at the central pole of a dim club.",
      actionDescription: POLE_ACTION,
      cameraMovement: "Slow push-in from medium wide to medium close-up as she approaches the pole.",
      storyBeat: "She begins a slow Pole Walk around the central pole",
      charactersPresent: [],
    }));
    return { project, drafts };
  });
}

describe("the deterministic image fallback", () => {
  it("gives each frame its own instant instead of the whole narrated action", async () => {
    const { project, drafts } = await fixture();
    const { startFramePrompt, endFramePrompt } = buildImagePrompts(project, drafts[0]!);

    expect(startFramePrompt).toContain("completes one full circle around the pole");
    expect(startFramePrompt).not.toContain("settles into a seated position");
    expect(endFramePrompt).toContain("settles into a seated position");
    expect(endFramePrompt).not.toContain("initiates a deep Body Roll");
    expect(endFramePrompt).not.toContain("completes one full circle");
  });

  it("carries no camera move, no sequence wording and no scene-number meta text", async () => {
    const { project, drafts } = await fixture();
    const { startFramePrompt, endFramePrompt } = buildImagePrompts(project, drafts[0]!);
    for (const prompt of [startFramePrompt, endFramePrompt]) {
      expect(prompt).not.toMatch(/push-in|first instant|last instant|setting up scene|Closing framing/i);
      expect(describesMotion(prompt)).toBe(false);
    }
  });

  it("is far shorter than the template it replaces", async () => {
    const { project, drafts } = await fixture();
    const { startFramePrompt } = buildImagePrompts(project, drafts[0]!);
    expect(startFramePrompt.split(/\s+/).length).toBeLessThan(POLE_ACTION.split(/\s+/).length);
  });
});

describe("a model prompt that still describes motion", () => {
  const motion = {
    startFramePrompt:
      "Medium wide shot, eye level. TLBr3f grips the central pole with both hands at hip height, " +
      "her hips swaying in slow rhythmic control as she begins her pole walk. The camera slowly " +
      "tilts up her body while she moves.",
    endFramePrompt:
      "Medium wide shot, eye level. TLBr3f sits on the lower bar with her thighs wrapped around " +
      "it, tracking movement around the pole, her hips rolling back and forth over the chrome bar.",
    imageNegativePrompt: "blur",
  };

  it("is flagged by the gate", async () => {
    const { drafts } = await fixture();
    const ctx = { scene: drafts[0]!, participants: [], explicit: false };
    expect(gateImagePrompt(motion.startFramePrompt, "start", ctx)).toContain("motion_in_still");
    expect(gateImagePrompt(motion.endFramePrompt, "end", ctx)).toContain("motion_in_still");
  });

  it("is retried with the reason, then shipped without the camera and rhythm wording", async () => {
    const { project, drafts } = await fixture();
    const systems: string[] = [];
    const provider: PlanningProvider = {
      name: "motion-test",
      async generateJson(system, _user, schema) {
        if (system.includes("Image Prompt Agent")) {
          systems.push(system);
          return schema.parse(motion);
        }
        return schema.parse({
          videoPromptSegment: "TLBr3f walks the pole.",
          videoNegativePrompt: "flicker",
          promptQualityChecklist: [],
        });
      },
    };
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [drafts[0]!], provider, {
      onExecution: (e) => executions.push(e),
    });

    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("a single frame cannot show");
    for (const prompt of [scene!.prompts.startFramePrompt, scene!.prompts.endFramePrompt]) {
      expect(prompt).not.toMatch(/camera|rhythmic|back and forth/i);
      expect(prompt).toContain("TLBr3f");
    }
    expect(executions.find((e) => e.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "hybrid",
      status: "degraded",
      detail: expect.stringContaining("repaired=motion_in_still"),
    });
  });

  it("says when a defect is still there after the repair, apart from the ones it fixed", async () => {
    const { project, drafts } = await fixture();
    const stubborn = {
      startFramePrompt:
        "Medium wide shot, eye level. TLBr3f begins her walk around the central pole with both " +
        "hands gripping the chrome at hip height, bare feet planted on the polished stage floor.",
      endFramePrompt:
        "Medium wide shot, eye level. TLBr3f sits on the lower bar, the camera tracking up her " +
        "body, her thighs wrapped around the chrome and both hands gripping above her head.",
      imageNegativePrompt: "blur",
    };
    const provider: PlanningProvider = {
      name: "motion-test",
      async generateJson(system, _user, schema) {
        return system.includes("Image Prompt Agent")
          ? schema.parse(stubborn)
          : schema.parse({
              videoPromptSegment: "TLBr3f walks the pole.",
              videoNegativePrompt: "flicker",
              promptQualityChecklist: [],
            });
      },
    };
    const executions: ArtifactExecution[] = [];
    await attachScenePrompts(project, [drafts[0]!], provider, {
      onExecution: (e) => executions.push(e),
    });
    // The camera clause was removed; "begins her walk" is only ever a retry reason.
    expect(executions.find((e) => e.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "hybrid",
      status: "degraded",
      detail: expect.stringMatching(/unresolved=[a-z_,]*motion_in_still/),
    });
  });
});

describe("motion the detector used to miss", () => {
  it.each([
    "Camera tracked forward as she pulled herself through the bars.",
    "Low angle three-quarter front camera tracking up through the chrome reflection.",
    "Camera pushed to MCU framing on the man.",
    "She is upright as she pulled herself through the bars.",
    "TLBr3f stands and then she walks to the window.",
    "She slowly rises from the floor.",
  ])("flags %s", (text) => {
    expect(describesMotion(text)).toBe(true);
  });

  it.each([
    "Camera height is eye level and the camera angle is low three-quarter rear.",
    "TLBr3f stands facing away, her body turned toward the window, caught mid-stride.",
    "Both hands grip the pole above her head, her thighs wrapped around it.",
  ])("passes %s", (text) => {
    expect(describesMotion(text)).toBe(false);
  });

  it("removes a camera phrase without losing the framing it was written into", () => {
    const stripped = stripMotion(
      "Low angle three-quarter front camera tracking up through chrome reflection as TLBr3f, a " +
        "blonde woman, drops onto the stage floor on hands and knees.",
    );
    expect(stripped).not.toMatch(/camera|tracking/i);
    expect(stripped).toContain("Low angle three-quarter front");
    expect(stripped).toContain("TLBr3f");
    expect(stripped).toContain("hands and knees");
  });

  it("removes a camera sentence that follows the pose, keeping the pose", () => {
    expect(
      stripMotion("She stands upright gripping the bar. Camera tracked forward as she pulled herself up."),
    ).toBe("She stands upright gripping the bar.");
  });
});
