import { describe, it, expect } from "vitest";
import { directorAgent, cinematographerAgent } from "@/lib/agents/canvas-agents";
import { segmentsMissingFrom } from "@/lib/agents/creative-context";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";

/**
 * A per-scene plan that stops early.
 *
 * The Director and Cinematographer each wrote their whole plan in one call, so
 * a model that ran out of things to say part way through left the remaining
 * scenes with no intent and no shot plan. Live: `sceneIntent covers 18 of 24
 * segments`, detected and reported, with nothing acting on it. A second call
 * asking only for the gap costs one round trip and rescues the scenes.
 */

const project = {
  id: "p",
  title: "A piece",
  segmentCount: 24,
  segmentSeconds: 20,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
} as unknown as Project;

/** Answers with `upTo` segments first, then everything asked for after that. */
function shortThenComplete(upTo: number, field: "sceneIntent" | "sceneShotPlans") {
  const calls: string[] = [];
  const provider: PlanningProvider = {
    name: "fake",
    async generateJson(_system: string, user: string) {
      calls.push(user);
      const asked = (JSON.parse(user) as { writeOnlyTheseSegments?: number[] })
        .writeOnlyTheseSegments;
      if (asked) {
        return { entries: Object.fromEntries(asked.map((n) => [String(n), `intent ${n}`])) };
      }
      const partial = Object.fromEntries(
        Array.from({ length: upTo }, (_, i) => [String(i + 1), `intent ${i + 1}`]),
      );
      return field === "sceneIntent"
        ? {
            creativeThesis: "t",
            pacingStrategy: "p",
            emotionalArc: ["a"],
            performanceDirection: ["d"],
            sceneIntent: partial,
            approvalNotes: ["n"],
          }
        : {
            cameraLanguage: "c",
            lensAndFramingRules: ["l"],
            movementRules: ["m"],
            lightingRules: ["li"],
            sceneShotPlans: partial,
            transitionLanguage: ["t"],
          };
    },
  } as unknown as PlanningProvider;
  return { provider, calls };
}

describe("a directorial plan that covers only some segments", () => {
  it("asks again for exactly the segments it left out", async () => {
    const { provider, calls } = shortThenComplete(18, "sceneIntent");

    const plan = await directorAgent(project, provider);

    expect(segmentsMissingFrom(plan.sceneIntent, 24)).toEqual([]);
    expect(calls).toHaveLength(2);
    const followUp = JSON.parse(calls[1]!) as { writeOnlyTheseSegments: number[] };
    expect(followUp.writeOnlyTheseSegments).toEqual([19, 20, 21, 22, 23, 24]);
  });

  it("keeps what the first answer wrote", async () => {
    const { provider } = shortThenComplete(18, "sceneIntent");

    const plan = await directorAgent(project, provider);

    expect(plan.sceneIntent["1"]).toBe("intent 1");
    expect(plan.sceneIntent["18"]).toBe("intent 18");
    expect(plan.creativeThesis).toBe("t");
  });

  it("does not call again when the first answer covered everything", async () => {
    const { provider, calls } = shortThenComplete(24, "sceneIntent");

    await directorAgent(project, provider);

    expect(calls).toHaveLength(1);
  });

  /** A model with nothing to say for a scene says nothing however often asked. */
  it("gives up rather than looping when a round adds nothing", async () => {
    const calls: string[] = [];
    const provider = {
      name: "fake",
      async generateJson(_system: string, user: string) {
        calls.push(user);
        if ((JSON.parse(user) as { writeOnlyTheseSegments?: number[] }).writeOnlyTheseSegments) {
          return { entries: {} };
        }
        return {
          creativeThesis: "t",
          pacingStrategy: "p",
          emotionalArc: ["a"],
          performanceDirection: ["d"],
          sceneIntent: { "1": "intent 1" },
          approvalNotes: ["n"],
        };
      },
    } as unknown as PlanningProvider;

    const plan = await directorAgent(project, provider);

    // One plan call, then one fruitless follow-up, then it stops.
    expect(calls).toHaveLength(2);
    expect(plan.sceneIntent["1"]).toBe("intent 1");
  });

  /** The follow-up is as free to answer "Scene 19" as "19". */
  it("normalises whatever key the follow-up answers with", async () => {
    const provider = {
      name: "fake",
      async generateJson(_system: string, user: string) {
        const asked = (JSON.parse(user) as { writeOnlyTheseSegments?: number[] })
          .writeOnlyTheseSegments;
        if (asked) {
          return { entries: Object.fromEntries(asked.map((n) => [`Scene ${n}`, `intent ${n}`])) };
        }
        return {
          creativeThesis: "t",
          pacingStrategy: "p",
          emotionalArc: ["a"],
          performanceDirection: ["d"],
          sceneIntent: { "1": "intent 1" },
          approvalNotes: ["n"],
        };
      },
    } as unknown as PlanningProvider;

    const plan = await directorAgent(project, provider);

    expect(segmentsMissingFrom(plan.sceneIntent, 24)).toEqual([]);
    expect(plan.sceneIntent["24"]).toBe("intent 24");
  });
});

describe("a cinematography plan that covers only some segments", () => {
  it("fills its own gap the same way", async () => {
    const { provider, calls } = shortThenComplete(20, "sceneShotPlans");

    const plan = await cinematographerAgent(project, provider);

    expect(segmentsMissingFrom(plan.sceneShotPlans, 24)).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
