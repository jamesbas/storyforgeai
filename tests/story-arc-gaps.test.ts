import { describe, it, expect } from "vitest";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * The arc is the one artifact everything downstream is built on, and it was the
 * only canvas agent still discarding a good answer for being short.
 *
 * Live, six consecutive runs: `story_plan | deterministic/degraded |
 * short_collection`, while the World Builder, Director, Cinematographer and Art
 * Director all returned `llm/ok`. The model was writing an arc every time and
 * the count check was throwing it away — logline, progression and all — for a
 * numbered template the Storyboard Artist then had to invent around.
 */

const project = {
  id: "p",
  title: "A piece",
  concept: "Two people meet in a hotel bar and the evening turns.",
  segmentCount: 24,
  segmentSeconds: 20,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
  creativeMode: "film_short",
} as unknown as Project;

/** Answers with `upTo` beats first, then exactly the beats asked for after. */
function shortThenComplete(upTo: number) {
  const calls: string[] = [];
  const provider = {
    name: "fake",
    async generateJson(_system: string, user: string) {
      calls.push(user);
      const asked = (JSON.parse(user) as { writeOnlyTheseSegments?: number[] })
        .writeOnlyTheseSegments;
      if (asked) {
        return { entries: Object.fromEntries(asked.map((n) => [String(n), `beat ${n}`])) };
      }
      return {
        projectId: "p",
        logline: "A real logline the model wrote.",
        synopsis: "A real synopsis.",
        segmentBeats: Array.from({ length: upTo }, (_, i) => `beat ${i + 1}`),
        emotionalProgression: Array.from({ length: upTo }, (_, i) => `feeling ${i + 1}`),
      };
    },
  } as unknown as PlanningProvider;
  return { provider, calls };
}

function ctx(executions: ArtifactExecution[]): AgentContext {
  return {
    project,
    brief: { logline: "l", synopsis: "s" },
    onExecution: (e: ArtifactExecution) => executions.push(e),
  } as unknown as AgentContext;
}

describe("a story arc that stops short of the segment count", () => {
  it("asks again for the beats it left out instead of discarding the arc", async () => {
    const { provider } = shortThenComplete(20);
    const plan = await storyArchitectAgent(ctx([]), provider);

    expect(plan.segmentBeats).toHaveLength(24);
    expect(plan.logline).toBe("A real logline the model wrote.");
    expect(plan.segmentBeats[23]).toBe("beat 24");
  });

  it("keeps the beats the model already wrote", async () => {
    const { provider } = shortThenComplete(20);
    const plan = await storyArchitectAgent(ctx([]), provider);
    expect(plan.segmentBeats.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => `beat ${i + 1}`),
    );
  });

  it("records the arc as the model's work, not the builder's", async () => {
    const executions: ArtifactExecution[] = [];
    const { provider } = shortThenComplete(20);
    await storyArchitectAgent(ctx(executions), provider);

    const run = executions.find((e) => e.artifact === "story_plan");
    expect(run?.source).not.toBe("deterministic");
  });

  it("asks for exactly the missing beat numbers", async () => {
    const { provider, calls } = shortThenComplete(20);
    await storyArchitectAgent(ctx([]), provider);

    const followUp = calls
      .map((c) => JSON.parse(c) as { writeOnlyTheseSegments?: number[] })
      .find((c) => c.writeOnlyTheseSegments);
    expect(followUp?.writeOnlyTheseSegments).toEqual([21, 22, 23, 24]);
  });

  it("does not make a second call when the first answer is complete", async () => {
    const { provider, calls } = shortThenComplete(24);
    const plan = await storyArchitectAgent(ctx([]), provider);

    expect(plan.segmentBeats).toHaveLength(24);
    expect(calls).toHaveLength(1);
  });

  it("still reports a shortfall it could not fill", async () => {
    // A model with nothing more to say must not be recorded as having answered.
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "fake",
      async generateJson(_system: string, user: string) {
        const asked = (JSON.parse(user) as { writeOnlyTheseSegments?: number[] })
          .writeOnlyTheseSegments;
        if (asked) return { entries: {} };
        return {
          projectId: "p",
          logline: "l",
          synopsis: "s",
          segmentBeats: ["beat 1", "beat 2"],
          emotionalProgression: ["f1", "f2"],
        };
      },
    } as unknown as PlanningProvider;

    await storyArchitectAgent(ctx(executions), provider);
    const run = executions.find((e) => e.artifact === "story_plan");
    expect(run?.fallbackReason).toBe("short_collection");
  });
});
