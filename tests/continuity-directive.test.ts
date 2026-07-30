import { describe, it, expect } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { computeSegmentation } from "@/lib/duration";
import {
  cameraContinuityDirective,
  isContinuousTake,
  seamDirective,
} from "@/lib/agents/continuity";
import { cinematographerAgent } from "@/lib/agents/canvas-agents";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";
import type { SceneContinuityMode } from "@/lib/types";

/** The deterministic builders need a brief, plan and bible in hand. */
function draftsFor(project: Project) {
  const brief = buildCreativeBrief(project);
  return buildSceneDrafts(project, buildStoryPlan(project), brief, buildVisualBible(project));
}

/**
 * What the planning agents are told about how the segments join.
 *
 * A segment boundary is a technical join — the video model renders about twenty
 * seconds at a time — but the agents were told to vary shot size across the
 * storyboard, so a continuous piece came back as a three-shot edit and the
 * renderer then reused the frame across the invented cut. `sceneContinuity` was
 * already on the project and no system prompt had ever read it.
 */

function makeProject(mode?: SceneContinuityMode): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "p",
    title: "P",
    concept: "Tracey dances with two men on the floor of a local bar.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "sensual",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "keyframes_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...(mode ? { sceneContinuity: mode } : {}),
  } as Project;
}

/** Records what each agent was actually sent. */
function recorder() {
  const calls: { system: string; user: string }[] = [];
  const provider: PlanningProvider = {
    name: "test",
    generateJson: async <T,>(
      system: string,
      user: string,
      _schema: ZodType<T, ZodTypeDef, unknown>,
    ) => {
      calls.push({ system, user });
      return null as T | null;
    },
  };
  return { calls, provider };
}

describe("reading the project's continuity mode", () => {
  it("treats the frame-reusing modes as one continuous take", () => {
    expect(isContinuousTake(makeProject("reuse_end_frame"))).toBe(true);
    expect(isContinuousTake(makeProject("continue_video"))).toBe(true);
  });

  it("treats an explicit cut as separate shots", () => {
    expect(isContinuousTake(makeProject("cut"))).toBe(false);
  });

  /** The default is reuse_end_frame, so a project that says nothing is continuous. */
  it("defaults to continuous when the project states no mode", () => {
    expect(isContinuousTake(makeProject())).toBe(true);
  });
});

describe("what the Cinematographer is told about shot size", () => {
  /**
   * The instruction that caused the defect: "vary sizes deliberately across the
   * storyboard" is craft advice for an edited film and wrong for one long take.
   */
  it("does not ask for varied shot sizes on a continuous take", () => {
    const directive = cameraContinuityDirective(makeProject("reuse_end_frame"));
    expect(directive).not.toMatch(/vary sizes deliberately/i);
    expect(directive).toMatch(/one continuous take/);
    expect(directive).toMatch(/Do not change framing at a boundary/);
  });

  /** The user asked for movement variety, only not for cuts. */
  it("offers movement as the source of variety instead", () => {
    const directive = cameraContinuityDirective(makeProject("reuse_end_frame"));
    for (const move of ["push-in", "pull-out", "orbit", "arc", "pan", "tilt", "tracking"]) {
      expect(directive).toContain(move);
    }
  });

  it("keeps the shot-contrast advice for a project that really is cut together", () => {
    const directive = cameraContinuityDirective(makeProject("cut"));
    expect(directive).toMatch(/Vary sizes deliberately/);
    expect(directive).toMatch(/separate shots/);
  });

  it("reaches the agent", async () => {
    const { calls, provider } = recorder();
    await cinematographerAgent(makeProject("reuse_end_frame"), provider);
    expect(calls[0]!.system).toMatch(/one continuous take/);
  });
});

describe("what the prompt agents are told about the seam", () => {
  it("says nothing extra when the scenes are separate shots", () => {
    expect(seamDirective(makeProject("cut"))).toBe("");
  });

  it("requires the start frame to be the previous end frame", () => {
    const directive = seamDirective(makeProject("reuse_end_frame"));
    expect(directive).toMatch(/this scene's start frame is that exact image/);
    expect(directive).toMatch(/Never open a segment on a new framing/);
  });

  /** Movement is what makes the piece move, so the end frame may differ. */
  it("still allows the camera to move inside the segment", () => {
    expect(seamDirective(makeProject("reuse_end_frame"))).toMatch(
      /end frame may be tighter or wider than the start/,
    );
  });

  /**
   * An agent cannot match a frame it has not been shown. Scene 1 has nothing to
   * match; every later scene must be handed its predecessor's end frame.
   */
  it("hands each scene the previous scene's end-frame prompt", async () => {
    const project = makeProject("reuse_end_frame");
    const { calls, provider } = recorder();
    const drafts = draftsFor(project);
    await attachScenePrompts(project, drafts, provider);

    // Image and video calls alternate, so the image calls are the even ones.
    const imageCalls = calls.filter((_, i) => i % 2 === 0);
    expect(imageCalls).toHaveLength(drafts.length);

    const first = JSON.parse(imageCalls[0]!.user) as { previousEndFramePrompt?: string };
    expect(first.previousEndFramePrompt).toBeUndefined();

    for (const call of imageCalls.slice(1)) {
      const payload = JSON.parse(call.user) as { previousEndFramePrompt?: string };
      expect(payload.previousEndFramePrompt).toBeTruthy();
    }
  });
});

describe("the storyboard the deterministic builder writes", () => {
  it("joins segments continuously rather than cutting", () => {
    const drafts = draftsFor(makeProject("reuse_end_frame"));
    expect(drafts.slice(1).map((d) => d.transitionIn)).toEqual(
      Array(drafts.length - 1).fill("Continuous"),
    );
  });

  it("cuts when the project says its scenes are separate shots", () => {
    const drafts = draftsFor(makeProject("cut"));
    expect(drafts.slice(1).map((d) => d.transitionIn)).toEqual(
      Array(drafts.length - 1).fill("Cut"),
    );
  });
});
