import { describe, expect, it } from "vitest";
import { storyboardAgent } from "@/lib/agents/storyboard-agent";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * The storyboard's execution record carried no model, so after a per-stage
 * model choice nothing in the app said which model had written the scene cards.
 */

const project = {
  id: "p", title: "A piece", concept: "x", segmentCount: 4, segmentSeconds: 20,
  finalTrimSeconds: 0, modelStrategy: "auto", style: "cinematic", tone: "neutral",
  creativeMode: "film_short",
} as unknown as Project;

function context(executions: ArtifactExecution[]): AgentContext {
  return {
    project,
    brief: { logline: "l", synopsis: "s" },
    storyPlan: {
      projectId: "p", title: "T", logline: "l",
      emotionalProgression: ["a", "b", "c", "d"],
      segmentBeats: ["b1", "b2", "b3", "b4"],
    },
    visualBible: {
      projectId: "p", artDirection: "a", colorPalette: ["c"], lightingRules: ["l"],
      cameraStyle: "s", characters: [], locations: [], props: [], negativeRules: [],
    },
    cast: [],
    onExecution: (execution: ArtifactExecution) => executions.push(execution),
  } as unknown as AgentContext;
}

const cards = (numbers: number[]) => ({
  scenes: numbers.map((n) => ({
    id: `s-${n}`, projectId: "p", sceneNumber: n, title: `Scene ${n}`,
    visualDescription: `visual ${n}`, actionDescription: `action ${n}`, cameraMovement: "static",
    startTimeSeconds: 0, endTimeSeconds: 20, targetDurationSeconds: 20,
  })),
});

describe("which model wrote the scene cards", () => {
  it("is recorded on the storyboard execution", async () => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "fake",
      async generateJson() { return null; },
      async generate(_s: string, user: string): Promise<ProviderResult<unknown>> {
        const { segmentNumbers } = JSON.parse(user) as { segmentNumbers: number[] };
        return { ok: true, value: cards(segmentNumbers), provider: "fake", model: "big-27b" };
      },
    } as unknown as PlanningProvider;
    await storyboardAgent(context(executions), provider);
    expect(executions.find((e) => e.artifact === "storyboard")).toMatchObject({
      source: "llm", model: "big-27b",
    });
  });

  it("still works with a provider that only implements generateJson", async () => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "plain",
      async generateJson(_s: string, user: string) {
        const { segmentNumbers } = JSON.parse(user) as { segmentNumbers: number[] };
        return cards(segmentNumbers);
      },
    } as unknown as PlanningProvider;
    await storyboardAgent(context(executions), provider);
    const record = executions.find((e) => e.artifact === "storyboard")!;
    expect(record.source).toBe("llm");
    expect(record.model).toBeUndefined();
  });

  it("reports why a failed batch failed instead of a bare unknown", async () => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "down",
      async generateJson() { return null; },
      async generate(): Promise<ProviderResult<unknown>> {
        return { ok: false, reason: "timeout", provider: "down", model: "big-27b" };
      },
    } as unknown as PlanningProvider;
    await storyboardAgent(context(executions), provider);
    expect(executions.find((e) => e.artifact === "storyboard")).toMatchObject({
      source: "deterministic", fallbackReason: "timeout", model: "big-27b",
    });
  });
});
