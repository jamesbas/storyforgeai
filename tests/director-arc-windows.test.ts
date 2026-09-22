import { describe, it, expect } from "vitest";
import { directorAgent, cinematographerAgent } from "@/lib/agents/canvas-agents";
import { segmentsMissingFrom } from "@/lib/agents/creative-context";
import { SEGMENTS_PER_WINDOW } from "@/lib/agents/segment-windows";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { StoryPlan } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * The Director losing the story half way through it.
 *
 * Live, on a 27-segment project whose arc was fully written: asked for all 27
 * scene intents in one call the model wrote sixteen — not the first sixteen
 * segments, but the *whole film* compressed into sixteen, ending on the closing
 * wide shot of an empty dance floor at intent 16. The gap fill then asked for
 * 17 to 27 while telling it only "these segments have no entry", so it started
 * the action again from the middle. Beat 17 was the climax; intent 17 was a
 * reaction shot from ten beats earlier.
 *
 * Two things were missing and both are needed: a cap on the first call so the
 * model stops compressing, and the beats for the window so a continuation
 * directs the story rather than continuing whatever it last wrote.
 */

const project = {
  id: "p",
  title: "A piece",
  segmentCount: 27,
  segmentSeconds: 20,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
} as unknown as Project;

const BEAT_WORDS = [
  "crosses the floor toward the woman and sets his glass down on the brass rail",
  "turns her shoulder away from the table and stares at the jukebox lights",
  "lifts the bottle and pours slowly while the room behind him empties out",
  "steps between them and puts a flat palm against the door frame",
  "drops the coin into the slot and waits for the record to fall",
  "pulls the curtain back so the street light lands across the carpet",
];

function beatFor(n: number): string {
  return `Segment${n}: he ${BEAT_WORDS[n % BEAT_WORDS.length]}.`;
}

const storyPlan = {
  projectId: "p",
  title: "T",
  logline: "l",
  emotionalProgression: Array.from({ length: 27 }, (_, i) => `feeling ${i + 1}`),
  segmentBeats: Array.from({ length: 27 }, (_, i) => beatFor(i + 1)),
} as unknown as StoryPlan;

type Ask = { writeOnlyTheseSegments?: number[]; beatsForTheseSegments?: Record<string, string> };

/**
 * Writes entries only for the segments it is actually asked for, which is what
 * a compliant model does and what the live one did not.
 */
function capped(field: "sceneIntent" | "sceneShotPlans") {
  const windows: number[][] = [];
  const systems: string[] = [];
  const beatsSeen: Record<string, string>[] = [];
  const provider = {
    name: "fake",
    async generateJson(system: string, user: string) {
      systems.push(system);
      const ask = JSON.parse(user) as Ask;
      if (ask.writeOnlyTheseSegments) {
        windows.push(ask.writeOnlyTheseSegments);
        beatsSeen.push(ask.beatsForTheseSegments ?? {});
        return {
          entries: Object.fromEntries(
            ask.writeOnlyTheseSegments.map((n) => [String(n), `directs beat ${n}`]),
          ),
        };
      }
      const opening = Object.fromEntries(
        Array.from({ length: SEGMENTS_PER_WINDOW }, (_, i) => [
          String(i + 1),
          `directs beat ${i + 1}`,
        ]),
      );
      return field === "sceneIntent"
        ? {
            creativeThesis: "t",
            pacingStrategy: "p",
            emotionalArc: ["a"],
            performanceDirection: ["d"],
            sceneIntent: opening,
            approvalNotes: ["n"],
          }
        : {
            cameraLanguage: "c",
            lensAndFramingRules: ["l"],
            movementRules: ["m"],
            lightingRules: ["li"],
            sceneShotPlans: opening,
            transitionLanguage: ["t"],
          };
    },
  } as unknown as PlanningProvider;
  return { provider, windows, systems, beatsSeen };
}

describe("a directorial plan for a piece longer than one answer", () => {
  it("asks the first call for an opening rather than all 27 intents", async () => {
    const { provider, systems } = capped("sceneIntent");
    await directorAgent(project, provider, { storyPlan });

    expect(systems[0]).toContain(`segments 1 to ${SEGMENTS_PER_WINDOW} only`);
    expect(systems[0]).toContain("nothing written here may resolve or conclude the piece");
  });

  it("does not cap a piece that fits in one answer", async () => {
    const short = { ...project, segmentCount: 6 } as Project;
    const { provider, systems } = capped("sceneIntent");
    await directorAgent(short, provider, { storyPlan });

    expect(systems[0]).not.toContain("more than one answer can hold");
  });

  it("covers every segment, a window at a time", async () => {
    const { provider, windows } = capped("sceneIntent");
    const plan = await directorAgent(project, provider, { storyPlan });

    expect(segmentsMissingFrom(plan.sceneIntent, 27)).toEqual([]);
    expect(windows).toEqual([
      [9, 10, 11, 12, 13, 14, 15, 16],
      [17, 18, 19, 20, 21, 22, 23, 24],
      [25, 26, 27],
    ]);
  });

  /** The fix for the live fault: a window must know which beats it is directing. */
  it("names the beats each window has to direct, in the prompt and the payload", async () => {
    const { provider, systems, beatsSeen } = capped("sceneIntent");
    await directorAgent(project, provider, { storyPlan });

    const middle = systems[2]!;
    expect(middle).toContain(`17. ${beatFor(17)}`);
    expect(middle).toContain(`24. ${beatFor(24)}`);
    expect(middle).toContain("must be about that segment's beat and no other");
    // Not the beats of some other window.
    expect(middle).not.toContain(`9. ${beatFor(9)}`);

    expect(beatsSeen[1]).toEqual(
      Object.fromEntries([17, 18, 19, 20, 21, 22, 23, 24].map((n) => [String(n), beatFor(n)])),
    );
  });

  /**
   * Handing over the beats made copying them the easy path: live, every entry
   * in the first and last windows contained no word that was not in its beat.
   */
  it("tells every call that an entry which restates its beat is not an entry", async () => {
    const { provider, systems } = capped("sceneIntent");
    await directorAgent(project, provider, { storyPlan });

    for (const system of systems) {
      expect(system).toContain("could be read as a description of the action is not an entry");
    }
  });

  it("reports intents that are their beat in other words", async () => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "fake",
      async generateJson() {
        return {
          creativeThesis: "t",
          pacingStrategy: "p",
          emotionalArc: ["a"],
          performanceDirection: ["d"],
          // Every entry is its beat reordered, with nothing of its own added.
          sceneIntent: Object.fromEntries(
            Array.from({ length: 27 }, (_, i) => [
              String(i + 1),
              `${storyPlan.segmentBeats[i]} — ${storyPlan.segmentBeats[i]}`,
            ]),
          ),
          approvalNotes: ["n"],
        };
      },
    } as unknown as PlanningProvider;

    await directorAgent(project, provider, {
      storyPlan,
      onExecution: (e: ArtifactExecution) => executions.push(e),
    });

    const run = executions.find((e) => e.artifact === "directorial_plan");
    expect(run?.fallbackReason).toBe("invalid_set");
    expect(run?.detail).toContain("restate their beat");
  });

  it("says nothing when the intents add to their beats", async () => {
    const executions: ArtifactExecution[] = [];
    const provider = {
      name: "fake",
      async generateJson() {
        return {
          creativeThesis: "t",
          pacingStrategy: "p",
          emotionalArc: ["a"],
          performanceDirection: ["d"],
          sceneIntent: Object.fromEntries(
            Array.from({ length: 27 }, (_, i) => [
              String(i + 1),
              `She wants out and cannot say so; the room closes by one step, segment ${i + 1}.`,
            ]),
          ),
          approvalNotes: ["n"],
        };
      },
    } as unknown as PlanningProvider;

    await directorAgent(project, provider, {
      storyPlan,
      onExecution: (e: ArtifactExecution) => executions.push(e),
    });

    const run = executions.find((e) => e.artifact === "directorial_plan");
    expect(run?.status).toBe("ok");
    expect(run?.source).toBe("llm");
  });

  it("tells a window how much film is still to come, and the last one that it is last", async () => {
    const { provider, systems } = capped("sceneIntent");
    await directorAgent(project, provider, { storyPlan });

    expect(systems[1]).toContain("segments 9 to 16 of 27");
    expect(systems[1]).toContain("11 segments follow them");
    expect(systems.at(-1)).toContain("final segments of the piece");
  });

  it("still works when no arc was supplied", async () => {
    const { provider, systems } = capped("sceneIntent");
    const plan = await directorAgent(project, provider);

    expect(segmentsMissingFrom(plan.sceneIntent, 27)).toEqual([]);
    expect(systems[1]).not.toContain("story beats for exactly those segments");
  });
});

describe("a cinematography plan for the same piece", () => {
  it("is windowed and beat-aware in the same way", async () => {
    const { provider, windows, systems } = capped("sceneShotPlans");
    const plan = await cinematographerAgent(project, provider, { storyPlan });

    expect(segmentsMissingFrom(plan.sceneShotPlans, 27)).toEqual([]);
    expect(windows).toHaveLength(3);
    expect(systems[0]).toContain(`segments 1 to ${SEGMENTS_PER_WINDOW} only`);
    expect(systems[2]).toContain(`17. ${beatFor(17)}`);
  });
});
