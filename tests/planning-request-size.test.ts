import { describe, it, expect } from "vitest";
import { directorAgent, cinematographerAgent } from "@/lib/agents/canvas-agents";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { planningProject } from "@/lib/agents/creative-context";
import {
  arcOutline,
  condensed,
  OUTLINE_WORDS,
  planningPayloadOutline,
  RECENT_ENTRIES,
  SEGMENTS_PER_WINDOW,
  writtenBefore,
} from "@/lib/agents/segment-windows";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { StoryPlan } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";

/**
 * Planning requests must not grow with the project.
 *
 * Live, on a 50-segment piece: LM Studio rejected the Director's first request
 * — "request (22464 tokens) exceeds the available context size (18176 tokens)"
 * — and the Cinematographer's at 19,450, so both plans fell back to templates
 * and every scene card built on them was the poorer for it. Each request
 * carried the whole arc, every per-scene plan already written and a project
 * record with a seed and wardrobe entry per scene.
 */

const LONG_BEAT =
  "She crosses the tiled floor toward the glass door, lets the towel fall from her shoulders, " +
  "and steps under the water while the steam gathers against the panes and the light dims.";

function projectOf(segmentCount: number): Project {
  return {
    id: "p",
    title: "A piece",
    concept: "A woman showers.",
    segmentCount,
    segmentSeconds: 20,
    modelStrategy: "auto",
    style: "cinematic",
    tone: "sensual",
    sceneSeeds: Object.fromEntries(Array.from({ length: segmentCount }, (_, i) => [`p-scene-${i}`, 123456789])),
    wardrobeChanges: Object.fromEntries(Array.from({ length: segmentCount }, (_, i) => [
      `p-scene-${i}`, [{ characterId: "c", wardrobe: "nude, towel around her shoulders", mode: "within" }],
    ])),
  } as unknown as Project;
}

function planOf(segmentCount: number): StoryPlan {
  return {
    projectId: "p",
    title: "T",
    logline: "l",
    emotionalProgression: Array.from({ length: segmentCount }, () => "rising tension"),
    segmentBeats: Array.from({ length: segmentCount }, (_, i) => `Beat ${i + 1}. ${LONG_BEAT}`),
  } as unknown as StoryPlan;
}

/** Answers exactly what it is asked for, and records every request. */
function recorder(field: "sceneIntent" | "sceneShotPlans" | "segmentBeats") {
  const requests: { size: number; user: Record<string, unknown> }[] = [];
  const provider = {
    name: "fake",
    async generateJson(system: string, user: string) {
      const ask = JSON.parse(user) as Record<string, unknown> & { writeOnlyTheseSegments?: number[] };
      requests.push({ size: system.length + user.length, user: ask });
      const window = ask.writeOnlyTheseSegments ??
        Array.from({ length: SEGMENTS_PER_WINDOW }, (_, i) => i + 1);
      const entries = Object.fromEntries(window.map((n) => [String(n), `${LONG_BEAT} (${n})`]));
      if (ask.writeOnlyTheseSegments) {
        return { entries, emotions: Object.fromEntries(window.map((n) => [String(n), "rising"])) };
      }
      if (field === "segmentBeats") {
        return {
          title: "T", logline: "l",
          segmentBeats: window.map((n) => entries[String(n)]),
          emotionalProgression: window.map(() => "rising"),
        };
      }
      return field === "sceneIntent"
        ? {
            creativeThesis: "t", pacingStrategy: "p", emotionalArc: "e",
            performanceDirection: "d", sceneIntent: entries,
          }
        : {
            cameraLanguage: "c", lensAndFramingRules: ["l"], movementRules: ["m"],
            lightingRules: ["li"], transitionLanguage: ["t"], sceneShotPlans: entries,
          };
    },
  } as unknown as PlanningProvider;
  return { requests, provider };
}

async function largestRequest(
  agent: "director" | "cinematographer" | "arc",
  segmentCount: number,
): Promise<{ largest: number; requests: { size: number; user: Record<string, unknown> }[] }> {
  const project = projectOf(segmentCount);
  const storyPlan = planOf(segmentCount);
  const field = agent === "director" ? "sceneIntent" : agent === "cinematographer" ? "sceneShotPlans" : "segmentBeats";
  const { requests, provider } = recorder(field);
  const intents = Object.fromEntries(storyPlan.segmentBeats.map((beat, i) => [String(i + 1), beat]));
  if (agent === "director") await directorAgent(project, provider, { storyPlan });
  else if (agent === "cinematographer") {
    await cinematographerAgent(project, provider, {
      storyPlan,
      plans: { directorialPlan: { projectId: "p", creativeThesis: "t", pacingStrategy: "p", emotionalArc: "e", performanceDirection: "d", sceneIntent: intents } as never },
    });
  } else await storyArchitectAgent({ project, correlationId: "c" } as never, provider);
  return { largest: Math.max(...requests.map((r) => r.size)), requests };
}

describe("planning requests stay the same size as the project grows", () => {
  it.each(["director", "cinematographer", "arc"] as const)("%s", async (agent) => {
    const small = await largestRequest(agent, 16);
    const large = await largestRequest(agent, 100);
    // Every segment is still written, a window at a time.
    expect(large.requests.length).toBeGreaterThan(small.requests.length);
    // Six times the segments: only the condensed outline line per segment
    // grows — about 110 characters each, where every scene used to add its
    // full beat and its full plan entries to every request.
    const perSegment = (large.largest - small.largest) / (100 - 16);
    expect(perSegment).toBeLessThan(150);
  });

  it("sends a continuation only the last few entries, not everything written so far", async () => {
    const { requests } = await largestRequest("cinematographer", 100);
    const last = requests.at(-1)!.user;
    expect(Object.keys(last.alreadyWritten as object)).toHaveLength(RECENT_ENTRIES);
    expect(last.writeOnlyTheseSegments).toEqual([97, 98, 99, 100]);
  });

  it("keeps the arc's own continuations aware of the whole story so far", async () => {
    const { requests } = await largestRequest("arc", 40);
    const last = requests.at(-1)!.user as { alreadyWritten: object; earlierOutline: Record<string, string> };
    expect(Object.keys(last.alreadyWritten)).toHaveLength(RECENT_ENTRIES);
    expect(Object.keys(last.earlierOutline)).toHaveLength(32 - RECENT_ENTRIES);
  });

  it("never sends a project's per-scene seeds or wardrobe changes to a planning agent", async () => {
    const { requests } = await largestRequest("director", 30);
    for (const { user } of requests) {
      const project = user.project as Record<string, unknown>;
      expect(project.sceneSeeds).toBeUndefined();
      expect(project.wardrobeChanges).toBeUndefined();
      expect(project.concept).toBe("A woman showers.");
    }
  });
});

describe("the outline a window carries", () => {
  it("keeps the window's beats whole and condenses the rest", () => {
    const beats = planOf(20).segmentBeats;
    const outline = arcOutline(beats, [9, 10]);
    expect(Object.keys(outline)).toHaveLength(20);
    expect(outline["9"]).toBe(beats[8]);
    expect(outline["1"]!.split(/\s+/)).toHaveLength(OUTLINE_WORDS);
    expect(outline["1"]).toMatch(/…$/);
  });

  it("leaves a short entry alone", () => {
    expect(condensed("  She steps in.  ")).toBe("She steps in.");
  });

  it("takes the entries just before a window, however they were keyed", () => {
    const map = { "Scene 1": "a", "2": "b", "3": "c", "4": "d", "5": "e", "12": "later" };
    expect(writtenBefore(map, [6, 7])).toEqual({ alreadyWritten: { "3": "c", "4": "d", "5": "e" } });
    expect(writtenBefore(map, [6, 7], { outlineEarlier: true }).earlierOutline).toEqual({ "1": "a", "2": "b" });
  });

  it("condenses per-scene plans for agents writing project-level documents", () => {
    const outline = planningPayloadOutline({
      directorialPlan: { sceneIntent: { "1": `${LONG_BEAT} ${LONG_BEAT}` } } as never,
    });
    expect(outline?.directorialPlan?.sceneIntent["1"]!.split(/\s+/)).toHaveLength(OUTLINE_WORDS);
  });

  it("drops only render settings and per-scene bookkeeping from the project", () => {
    const kept = planningProject({ ...projectOf(3), climax: "the kiss", imageModel: "krea", status: "draft" });
    expect(kept).toMatchObject({ concept: "A woman showers.", segmentCount: 3, climax: "the kiss", style: "cinematic" });
    expect(kept).not.toHaveProperty("imageModel");
    expect(kept).not.toHaveProperty("status");
    expect(kept).not.toHaveProperty("sceneSeeds");
  });
});
