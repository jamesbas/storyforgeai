import { describe, it, expect } from "vitest";
import { applyVariantToBrief } from "@/lib/agents/variant-set";
import { segmentsMissingFrom } from "@/lib/agents/creative-context";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import type { ArtifactExecution } from "@/lib/schemas/provenance";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { CreativeBrief } from "@/lib/schemas/agents";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import type { Project } from "@/lib/schemas/project";

/**
 * The chosen direction reaching every planning path, and per-segment plans
 * being counted rather than assumed.
 */

const BRIEF = {
  logline: "A woman returns to the house she grew up in.",
  synopsis: "s",
  arc: { setup: "a", development: "b", resolution: "c" },
  visualStyle: "cinematic",
  tone: "quiet",
  audience: "adults",
  constraints: ["Keep it under two minutes"],
} as unknown as CreativeBrief;

const VARIANT = {
  id: "v1",
  name: "The Long Way Back",
  summary: "She takes the coast road and arrives at dusk.",
  hook: "Open on the empty passenger seat.",
  storyAngle: "Grief told through the drive rather than the house.",
  visualStyle: "Handheld, natural light.",
  variantType: "story",
  risks: ["Less time inside the house", "Slower opening"],
} as unknown as CreativeVariant;

describe("carrying the selected direction into the brief", () => {
  it("keeps the constraints already there", () => {
    const merged = applyVariantToBrief(BRIEF, VARIANT);
    expect(merged.constraints).toContain("Keep it under two minutes");
  });

  it("carries the substance, not just the name", () => {
    const merged = applyVariantToBrief(BRIEF, VARIANT).constraints.join(" ");
    expect(merged).toContain("The Long Way Back");
    expect(merged).toContain("Open on the empty passenger seat.");
    expect(merged).toContain("Grief told through the drive");
    expect(merged).toContain("Handheld, natural light.");
  });

  /**
   * The Variant Explorer is told risks name "what this direction gives up".
   * Turning them into "Avoid: slower opening" inverted a description of the
   * cost into an instruction to work against the direction the creator chose.
   */
  it("presents the tradeoffs as context rather than exclusions", () => {
    const merged = applyVariantToBrief(BRIEF, VARIANT).constraints.join(" ");
    expect(merged).not.toMatch(/Avoid:/);
    expect(merged).toContain("Tradeoffs this direction accepts");
    expect(merged).toContain("Slower opening");
  });

  it("changes nothing when no direction was chosen", () => {
    expect(applyVariantToBrief(BRIEF, undefined)).toEqual(BRIEF);
  });
});

/**
 * `sceneIntent` and `sceneShotPlans` are `z.record(z.string())`, so a plan
 * asked for one entry per segment parses with none.
 */
describe("counting a per-scene plan against the segments", () => {
  it("finds nothing missing when every segment is covered", () => {
    expect(segmentsMissingFrom({ "1": "a", "2": "b", "3": "c" }, 3)).toEqual([]);
  });

  it("names the segments a plan skipped", () => {
    expect(segmentsMissingFrom({ "1": "a", "3": "c" }, 3)).toEqual([2]);
  });

  it("treats an empty entry as missing", () => {
    expect(segmentsMissingFrom({ "1": "a", "2": "   " }, 2)).toEqual([2]);
  });

  /** The same key spellings `sceneCreativeSlice` accepts at render time. */
  it("accepts the key spellings the plans actually use", () => {
    expect(segmentsMissingFrom({ "scene 1": "a", "Scene 2": "b" }, 2)).toEqual([]);
  });

  it("reports everything missing when the map is absent", () => {
    expect(segmentsMissingFrom(undefined, 2)).toEqual([1, 2]);
  });

  it("claims nothing when the project states no segment count", () => {
    expect(segmentsMissingFrom({ "1": "a" }, undefined)).toEqual([]);
  });
});

/**
 * Beats and emotions are two independent arrays in the schema and only the
 * beats were counted. The storyboard slices the emotions per batch, so a short
 * list left every batch after the first with no emotional direction at all.
 */
describe("one emotional value per segment", () => {
  const project = {
    id: "p",
    title: "Coast Road",
    concept: "A woman drives the coast road back to the house she grew up in.",
    style: "cinematic",
    tone: "quiet",
    segmentCount: 3,
    segmentSeconds: 8,
  } as unknown as Project;

  const planning = (emotionalProgression: string[]) => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "test",
      generateJson: async <T,>() =>
        ({
          projectId: "p",
          title: "T",
          logline: "L",
          emotionalProgression,
          segmentBeats: ["one", "two", "three"],
        }) as unknown as T,
    } as unknown as PlanningProvider;
    return { provider, executions };
  };

  it("fills a short list so every segment has one", async () => {
    const { provider, executions } = planning(["uneasy"]);
    const plan = await storyArchitectAgent(
      { project, onExecution: (e) => executions.push(e) },
      provider,
    );

    expect(plan.emotionalProgression).toHaveLength(3);
    expect(plan.emotionalProgression[0]).toBe("uneasy");
    expect(plan.emotionalProgression.every((value) => value.trim())).toBe(true);
  });

  it("drops the extras when the model overshoots", async () => {
    const { provider } = planning(["a", "b", "c", "d", "e"]);
    const plan = await storyArchitectAgent({ project }, provider);
    expect(plan.emotionalProgression).toEqual(["a", "b", "c"]);
  });

  /** A padded arc is not the model's work, and the record should say so. */
  it("records the repair rather than passing it off as the model's", async () => {
    const { provider, executions } = planning(["uneasy"]);
    await storyArchitectAgent({ project, onExecution: (e) => executions.push(e) }, provider);

    const execution = executions.find((e) => e.artifact === "story_plan")!;
    expect(execution.source).toBe("hybrid");
    expect(execution.detail).toContain("emotionalProgression 1 of 3");
  });

  it("leaves a complete list alone", async () => {
    const { provider, executions } = planning(["calm", "tense", "resolved"]);
    const plan = await storyArchitectAgent(
      { project, onExecution: (e) => executions.push(e) },
      provider,
    );

    expect(plan.emotionalProgression).toEqual(["calm", "tense", "resolved"]);
    expect(executions.find((e) => e.artifact === "story_plan")!.source).toBe("llm");
  });
});
