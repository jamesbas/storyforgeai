import { describe, it, expect } from "vitest";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { repeatedBeats } from "@/lib/agents/arc-repetition";
import { SEGMENTS_PER_FOLLOW_UP } from "@/lib/agents/segment-gaps";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * The arc over about eighteen segments.
 *
 * Live, a 27-segment piece: the model wrote sixteen beats and sixteen emotional
 * values and stopped. The beats were repaired by a single follow-up asking for
 * all eleven at once — which produced nine beats of aftermath and a last two
 * that were word-for-word identical — while the emotional progression was not
 * repaired at all, so segments 17 to 26 were handed to the storyboard as
 * "rising tension" over beats where the story had already ended. The badge said
 * `hybrid · short_collection` and nothing said which half was wrong.
 */

const project = {
  id: "p",
  title: "A piece",
  concept: "Two people meet in a hotel bar and the evening turns.",
  segmentCount: 27,
  segmentSeconds: 20,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
  creativeMode: "film_short",
} as unknown as Project;

function ctx(executions: ArtifactExecution[] = []): AgentContext {
  return {
    project,
    brief: { logline: "l", synopsis: "s" },
    onExecution: (e: ArtifactExecution) => executions.push(e),
  } as unknown as AgentContext;
}

type Ask = { writeOnlyTheseSegments?: number[] };

/**
 * Beats that read as different beats.
 *
 * Every segment gets its own vocabulary, because the arc is now checked for
 * beats that repeat their neighbour and a fake answering "beat 1", "beat 2"
 * trips that check for a reason that has nothing to do with what is under test.
 */
const VOCAB = [
  "ladder",
  "kettle",
  "harbour",
  "marble",
  "lantern",
  "cactus",
  "violin",
  "anchor",
  "ribbon",
  "thistle",
  "compass",
  "satchel",
];
function beatText(n: number): string {
  const pick = (offset: number) => VOCAB[(n * offset + offset) % VOCAB.length];
  return `segment${n} ${pick(3)} ${pick(5)} ${pick(7)}`;
}

/**
 * Stops after `upTo` in both collections, then answers continuations honestly —
 * including the emotional value, which is what the live model was never asked
 * for.
 */
function stopsAfter(upTo: number) {
  const windows: number[][] = [];
  const systems: string[] = [];
  const provider = {
    name: "fake",
    async generateJson(system: string, user: string) {
      systems.push(system);
      const asked = (JSON.parse(user) as Ask).writeOnlyTheseSegments;
      if (asked) {
        windows.push(asked);
        return {
          entries: Object.fromEntries(asked.map((n) => [String(n), beatText(n)])),
          emotions: Object.fromEntries(asked.map((n) => [String(n), `feeling ${n}`])),
        };
      }
      return {
        projectId: "p",
        title: "T",
        logline: "A real logline the model wrote.",
        segmentBeats: Array.from({ length: upTo }, (_, i) => beatText(i + 1)),
        emotionalProgression: Array.from({ length: upTo }, (_, i) => `feeling ${i + 1}`),
      };
    },
  } as unknown as PlanningProvider;
  return { provider, windows, systems };
}

describe("an arc longer than one answer can hold", () => {
  it("asks the first call for an opening rather than the whole film", async () => {
    const { provider, systems } = stopsAfter(SEGMENTS_PER_FOLLOW_UP);
    await storyArchitectAgent(ctx(), provider);

    expect(systems[0]).toContain(`segments 1 to ${SEGMENTS_PER_FOLLOW_UP} only`);
    expect(systems[0]).toContain("nothing written here may resolve or conclude the piece");
  });

  it("does not cap a piece that fits in one answer", async () => {
    const short = { ...project, segmentCount: 6 } as Project;
    const { provider, systems } = stopsAfter(6);
    await storyArchitectAgent({ ...ctx(), project: short } as AgentContext, provider);

    expect(systems[0]).not.toContain("more than one answer can hold");
  });

  it("writes the rest a window at a time instead of all at once", async () => {
    const { provider, windows } = stopsAfter(SEGMENTS_PER_FOLLOW_UP);
    const plan = await storyArchitectAgent(ctx(), provider);

    expect(plan.segmentBeats).toHaveLength(27);
    expect(windows).toEqual([
      [9, 10, 11, 12, 13, 14, 15, 16],
      [17, 18, 19, 20, 21, 22, 23, 24],
      [25, 26, 27],
    ]);
  });

  /** The live failure: beats repaired, emotions left to the template. */
  it("fills the emotional value alongside the beat it belongs to", async () => {
    const { provider } = stopsAfter(16);
    const plan = await storyArchitectAgent(ctx(), provider);

    expect(plan.emotionalProgression).toHaveLength(27);
    expect(plan.emotionalProgression[16]).toBe("feeling 17");
    expect(plan.emotionalProgression[26]).toBe("feeling 27");
    expect(plan.emotionalProgression).not.toContain("rising tension");
  });

  it("records the arc as the model's own once nothing is left over", async () => {
    const executions: ArtifactExecution[] = [];
    const { provider } = stopsAfter(16);
    await storyArchitectAgent(ctx(executions), provider);

    const run = executions.find((e) => e.artifact === "story_plan");
    expect(run?.status).toBe("ok");
    expect(run?.source).toBe("llm");
  });

  it("tells a continuation where in the film it sits", async () => {
    const { provider, systems } = stopsAfter(SEGMENTS_PER_FOLLOW_UP);
    await storyArchitectAgent(ctx(), provider);

    const middle = systems[1]!;
    expect(middle).toContain("segments 9 to 16 of 27");
    expect(middle).toContain("do not");
    expect(middle).toContain("11 segments follow them");
    // The opening instruction must not travel with a window it contradicts.
    expect(middle).not.toContain(`segments 1 to ${SEGMENTS_PER_FOLLOW_UP} only`);
  });

  it("tells the last window it is the last, with the aftermath budget", async () => {
    const { provider, systems } = stopsAfter(SEGMENTS_PER_FOLLOW_UP);
    await storyArchitectAgent(ctx(), provider);

    expect(systems.at(-1)).toContain("final segments of the piece");
    expect(systems.at(-1)).toContain("At most 2 beats");
  });

  it("still falls back to the builder when no continuation answers", async () => {
    const provider = {
      name: "fake",
      async generateJson(_system: string, user: string) {
        if ((JSON.parse(user) as Ask).writeOnlyTheseSegments) return { entries: {} };
        return {
          projectId: "p",
          title: "T",
          logline: "l",
          segmentBeats: ["beat 1", "beat 2"],
          emotionalProgression: ["f1", "f2"],
        };
      },
    } as unknown as PlanningProvider;
    const executions: ArtifactExecution[] = [];

    const plan = await storyArchitectAgent(ctx(executions), provider);

    expect(plan.segmentBeats).toHaveLength(27);
    expect(executions.find((e) => e.artifact === "story_plan")?.fallbackReason).toBe(
      "short_collection",
    );
  });
});

describe("beats that repeat the beat before them", () => {
  it("finds an exact repeat and leaves a real arc alone", () => {
    expect(
      repeatedBeats([
        "Leroy stands from the high-top table and crosses the bar.",
        "The woman turns away from him towards the jukebox.",
        "The woman turns away from him towards the jukebox.",
      ]),
    ).toEqual([3]);
    expect(
      repeatedBeats([
        "Leroy stands from the high-top table and crosses the bar.",
        "The woman turns away from him towards the jukebox.",
        "Bill puts a coin down and the music changes.",
      ]),
    ).toEqual([]);
  });

  /** Padding is a rewrite of its neighbour, not always a copy of it. */
  it("finds a beat rewritten from the one before it", () => {
    expect(
      repeatedBeats([
        "A wide static shot holds on the empty bar, lights unchanged, nobody moving.",
        "A wide static shot holds on the empty bar, lights unchanged, nobody moves.",
      ]),
    ).toEqual([2]);
  });

  it("does not count two beats that merely share a location", () => {
    expect(
      repeatedBeats([
        "Leroy sets his glass down on the bar and looks at the door.",
        "The door opens and a woman in a floral sundress walks into the bar.",
      ]),
    ).toEqual([]);
  });

  it("reports a repeat against the arc rather than discarding it", async () => {
    const executions: ArtifactExecution[] = [];
    const beat = "The camera holds a final static wide shot of the low-ceilinged bar.";
    const provider = {
      name: "fake",
      async generateJson() {
        return {
          projectId: "p",
          title: "T",
          logline: "l",
          segmentBeats: Array.from({ length: 27 }, (_, i) => (i >= 25 ? beat : beatText(i + 1))),
          emotionalProgression: Array.from({ length: 27 }, (_, i) => `feeling ${i + 1}`),
        };
      },
    } as unknown as PlanningProvider;

    const plan = await storyArchitectAgent(ctx(executions), provider);

    const run = executions.find((e) => e.artifact === "story_plan");
    expect(run?.fallbackReason).toBe("invalid_set");
    expect(run?.detail).toContain("beats 27 repeat");
    // Reported, not thrown away.
    expect(plan.segmentBeats[0]).toBe(beatText(1));
  });
});
