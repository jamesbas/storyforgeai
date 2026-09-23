import { describe, it, expect } from "vitest";
import { storyboardAgent } from "@/lib/agents/storyboard-agent";
import { planningPayloadForSegments } from "@/lib/agents/creative-context";
import type { CreativePlans } from "@/lib/agents/creative-context";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";

/**
 * A scene card written against somebody else's beat.
 *
 * The storyboard is requested four cards at a time and carefully slices the
 * beats to match — but the Agentic Canvas plans went over whole, and
 * `sceneIntent` and `sceneShotPlans` are keyed by segment across the entire
 * project. So a call writing scenes 5 to 8 was given four beats and all
 * twenty-seven of the Director's intents, which is the rest of the film in
 * detail.
 *
 * Live on a 27-segment project, scene 8 ("The Encirclement") came back as
 * intents 8, 11 and 12 merged into one card: it opened on the men closing in,
 * then spun her, then had Leroy enter her — four later scenes of action
 * compressed into one twenty-second shot, while beat 8 was only "Leroy lifts
 * the hem of her sundress while Ray and Bill stand up".
 */

const project = {
  id: "p",
  title: "A piece",
  concept: "x",
  segmentCount: 12,
  segmentSeconds: 20,
  finalTrimSeconds: 0,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
  creativeMode: "film_short",
} as unknown as Project;

const plans = {
  directorialPlan: {
    projectId: "p",
    creativeThesis: "The thesis for the whole piece.",
    pacingStrategy: "steady",
    emotionalArc: ["a"],
    performanceDirection: ["d"],
    sceneIntent: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [String(i + 1), `intent for segment ${i + 1}`]),
    ),
    approvalNotes: ["n"],
  },
  cinematographyPlan: {
    projectId: "p",
    cameraLanguage: "The camera language for the whole piece.",
    lensAndFramingRules: ["35mm"],
    movementRules: ["m"],
    lightingRules: ["li"],
    sceneShotPlans: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [String(i + 1), `shot for segment ${i + 1}`]),
    ),
    transitionLanguage: ["Continuous"],
  },
} as unknown as CreativePlans;

function ctx(): AgentContext {
  return {
    project,
    brief: { logline: "l", synopsis: "s" },
    storyPlan: {
      projectId: "p",
      title: "T",
      logline: "l",
      emotionalProgression: Array.from({ length: 12 }, (_, i) => `feeling ${i + 1}`),
      segmentBeats: Array.from({ length: 12 }, (_, i) => `beat ${i + 1}`),
    },
    visualBible: {
      projectId: "p",
      artDirection: "a",
      colorPalette: ["c"],
      lightingRules: ["l"],
      cameraStyle: "s",
      characters: [],
      locations: [],
      props: [],
      negativeRules: [],
    },
    cast: [],
    plans,
  } as unknown as AgentContext;
}

/** Answers every batch with the right number of cards, recording what it saw. */
function recording() {
  const payloads: Record<string, unknown>[] = [];
  const systems: string[] = [];
  const provider = {
    name: "fake",
    async generateJson(system: string, user: string) {
      systems.push(system);
      const payload = JSON.parse(user) as { segmentNumbers: number[] };
      payloads.push(payload);
      return {
        scenes: payload.segmentNumbers.map((n) => ({
          id: `s-${n}`,
          projectId: "p",
          sceneNumber: n,
          title: `Scene ${n}`,
          visualDescription: `visual ${n}`,
          actionDescription: `action ${n}`,
          cameraMovement: "static",
          startTimeSeconds: 0,
          endTimeSeconds: 20,
          targetDurationSeconds: 20,
        })),
      };
    },
  } as unknown as PlanningProvider;
  return { provider, payloads, systems };
}

describe("the plans a storyboard batch is shown", () => {
  it("gives a batch only the scene intents for its own scenes", async () => {
    const { provider, payloads } = recording();
    await storyboardAgent(ctx(), provider);

    const second = payloads[1] as {
      segmentNumbers: number[];
      plans: { directorialPlan: { sceneIntent: Record<string, string> } };
    };
    expect(second.segmentNumbers).toEqual([5, 6, 7, 8]);
    expect(Object.keys(second.plans.directorialPlan.sceneIntent)).toEqual(["5", "6", "7", "8"]);
    // The live fault: intent 11 was in view while writing scene 8, and got used.
    expect(JSON.stringify(second.plans.directorialPlan.sceneIntent)).not.toContain("segment 11");
  });

  it("scopes the shot plans the same way", async () => {
    const { provider, payloads } = recording();
    await storyboardAgent(ctx(), provider);

    const second = payloads[1] as {
      plans: { cinematographyPlan: { sceneShotPlans: Record<string, string> } };
    };
    expect(Object.keys(second.plans.cinematographyPlan.sceneShotPlans)).toEqual([
      "5",
      "6",
      "7",
      "8",
    ]);
  });

  /** Thesis, camera language and the rest are meant to apply to every scene. */
  it("keeps the project-level plan fields whole", async () => {
    const { provider, payloads } = recording();
    await storyboardAgent(ctx(), provider);

    const second = payloads[1] as {
      plans: {
        directorialPlan: { creativeThesis: string };
        cinematographyPlan: { cameraLanguage: string; lensAndFramingRules: string[] };
      };
    };
    expect(second.plans.directorialPlan.creativeThesis).toBe("The thesis for the whole piece.");
    expect(second.plans.cinematographyPlan.cameraLanguage).toBe(
      "The camera language for the whole piece.",
    );
    expect(second.plans.cinematographyPlan.lensAndFramingRules).toEqual(["35mm"]);
  });

  it("pairs each beat with its segment number so a card cannot take the wrong one", async () => {
    const { provider, payloads } = recording();
    await storyboardAgent(ctx(), provider);

    const second = payloads[1] as { beatsBySegment: Record<string, string> };
    expect(second.beatsBySegment).toEqual({
      "5": "beat 5",
      "6": "beat 6",
      "7": "beat 7",
      "8": "beat 8",
    });
  });

  it("tells the batch not to bring a later beat forward", async () => {
    const { provider, systems } = recording();
    await storyboardAgent(ctx(), provider);

    expect(systems[1]).toContain("do not merge two beats into one card");
    expect(systems[1]).toContain("covers its own segment's beat and stops there");
  });
});

describe("planningPayloadForSegments", () => {
  it("keeps entries however the plan keyed them", () => {
    const oddlyKeyed = {
      directorialPlan: {
        ...(plans.directorialPlan as object),
        sceneIntent: { "Scene 5": "intent five", "6": "intent six" },
      },
    } as unknown as CreativePlans;

    const scoped = planningPayloadForSegments(oddlyKeyed, [5, 6]);

    expect(scoped?.directorialPlan?.sceneIntent).toEqual({
      "5": "intent five",
      "6": "intent six",
    });
  });

  it("returns nothing when there are no plans to scope", () => {
    expect(planningPayloadForSegments(undefined, [1, 2])).toBeUndefined();
    expect(planningPayloadForSegments({}, [1, 2])).toBeUndefined();
  });
});
