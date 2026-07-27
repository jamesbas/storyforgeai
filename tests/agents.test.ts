import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import { creativeBriefSchema, storyPlanSchema, visualBibleSchema } from "@/lib/schemas/agents";
import { sceneDraftSchema, sceneSchema } from "@/lib/schemas/storyboard";
import { intakeAgent, INTAKE_SYSTEM } from "@/lib/agents/intake-agent";
import { storyArchitectAgent, STORY_ARCHITECT_SYSTEM } from "@/lib/agents/story-architect-agent";
import { visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { storyboardAgent } from "@/lib/agents/storyboard-agent";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { buildCreativeBrief, buildStoryPlan, buildVisualBible } from "@/lib/agents/mock-agents";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";

function makeProject(requestedDurationSeconds = 60): Project {
  const seg = computeSegmentation(requestedDurationSeconds);
  const now = new Date().toISOString();
  return {
    id: "agents-project",
    title: "Agents Project",
    concept: "A kite escapes a child and tours the city.",
    requestedDurationSeconds,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "hopeful",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/** Provider that returns a canned value only for the given system prompts. */
function cannedProvider(map: Record<string, unknown>): PlanningProvider {
  return {
    name: "canned",
    async generateJson<T>(system: string, _user: string, _schema: ZodType<T>): Promise<T | null> {
      return (system in map ? (map[system] as T) : null);
    },
  };
}

describe("planning agents — deterministic fallback (no provider)", () => {
  const project = makeProject(60);
  const baseCtx: AgentContext = { project };

  it("intakeAgent produces a schema-valid brief", async () => {
    const brief = await intakeAgent(baseCtx, null);
    expect(() => creativeBriefSchema.parse(brief)).not.toThrow();
    expect(brief.projectId).toBe(project.id);
  });

  it("storyArchitectAgent produces one beat per segment", async () => {
    const plan = await storyArchitectAgent(baseCtx, null);
    expect(() => storyPlanSchema.parse(plan)).not.toThrow();
    expect(plan.segmentBeats).toHaveLength(project.segmentCount);
  });

  it("visualBibleAgent produces a schema-valid bible", async () => {
    const bible = await visualBibleAgent(baseCtx, null);
    expect(() => visualBibleSchema.parse(bible)).not.toThrow();
  });

  it("storyboardAgent produces segmentCount schema-valid drafts", async () => {
    const ctx: AgentContext = {
      project,
      brief: buildCreativeBrief(project),
      storyPlan: buildStoryPlan(project),
      visualBible: buildVisualBible(project),
    };
    const drafts = await storyboardAgent(ctx, null);
    expect(drafts).toHaveLength(project.segmentCount);
    for (const d of drafts) expect(() => sceneDraftSchema.parse(d)).not.toThrow();
  });

  it("prompt agents attach schema-valid prompts to each scene", async () => {
    const ctx: AgentContext = {
      project,
      brief: buildCreativeBrief(project),
      storyPlan: buildStoryPlan(project),
      visualBible: buildVisualBible(project),
    };
    const drafts = await storyboardAgent(ctx, null);
    const scenes = await attachScenePrompts(project, drafts, null);
    expect(scenes).toHaveLength(project.segmentCount);
    for (const s of scenes) {
      expect(() => sceneSchema.parse(s)).not.toThrow();
      // The prompt must state the segment length the clip has to fill.
      expect(s.prompts.videoPromptSegment).toMatch(/\b20 seconds\b/);
    }
  });

  it("builds a distinct prompt per scene from that scene's own content", async () => {
    const ctx: AgentContext = {
      project,
      brief: buildCreativeBrief(project),
      storyPlan: buildStoryPlan(project),
      visualBible: buildVisualBible(project),
    };
    const drafts = await storyboardAgent(ctx, null);
    const scenes = await attachScenePrompts(project, drafts, null);

    // Regression guard: the builders once ignored the scene draft entirely and
    // emitted the same prompt for every scene bar the number, which would have
    // produced near-identical clips across the whole film.
    const videoPrompts = new Set(scenes.map((s) => s.prompts.videoPromptSegment));
    const startPrompts = new Set(scenes.map((s) => s.prompts.startFramePrompt));
    expect(videoPrompts.size).toBe(scenes.length);
    expect(startPrompts.size).toBe(scenes.length);

    for (const s of scenes) {
      expect(s.prompts.videoPromptSegment).toContain(s.actionDescription);
      expect(s.prompts.videoPromptSegment).toContain(s.cameraMovement.toLowerCase());
      expect(s.prompts.startFramePrompt).toContain(s.visualDescription);
    }
  });

  it("quotes dialogue inline so the video model can perform it", async () => {
    const speaking = makeProject(40);
    speaking.dialogueRequired = true;
    const ctx: AgentContext = {
      project: speaking,
      brief: buildCreativeBrief(speaking),
      storyPlan: buildStoryPlan(speaking),
      visualBible: buildVisualBible(speaking),
    };
    const drafts = await storyboardAgent(ctx, null);
    const scenes = await attachScenePrompts(speaking, drafts, null);

    for (const s of scenes) {
      expect(s.dialogue?.length).toBeGreaterThan(0);
      const line = s.dialogue![0]!;
      expect(s.prompts.videoPromptSegment).toContain(`${line.character} says, "${line.line}"`);
      expect(s.prompts.promptQualityChecklist).toContain("dialogue quoted inline for lip sync");
    }
  });

  it("storyboardAgent throws without required context", async () => {
    await expect(storyboardAgent({ project }, null)).rejects.toThrow();
  });
});

describe("planning agents — provider path", () => {
  const project = makeProject(60);

  it("uses provider output and enforces projectId", async () => {
    const fixture = { ...buildCreativeBrief(project), projectId: "SHOULD_BE_OVERWRITTEN", logline: "custom" };
    const provider = cannedProvider({ [INTAKE_SYSTEM]: fixture });
    const brief = await intakeAgent({ project }, provider);
    expect(brief.logline).toBe("custom");
    expect(brief.projectId).toBe(project.id);
  });

  it("falls back to mock when provider returns a wrong-length story plan", async () => {
    const badPlan = { ...buildStoryPlan(project), segmentBeats: ["only one"] };
    const provider = cannedProvider({ [STORY_ARCHITECT_SYSTEM]: badPlan });
    const plan = await storyArchitectAgent({ project }, provider);
    expect(plan.segmentBeats).toHaveLength(project.segmentCount);
  });

  it("falls back to mock when provider returns null", async () => {
    const provider = cannedProvider({});
    const brief = await intakeAgent({ project }, provider);
    expect(brief.projectId).toBe(project.id);
  });
});
