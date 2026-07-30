import { describe, it, expect } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { computeSegmentation } from "@/lib/duration";
import {
  artDirectorAgent,
  cinematographerAgent,
  directorAgent,
  worldBuilderAgent,
  ART_DIRECTOR_SYSTEM,
  CINEMATOGRAPHER_SYSTEM,
  DIRECTOR_SYSTEM,
  WORLD_BUILDER_SYSTEM,
} from "@/lib/agents/canvas-agents";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";
import type { CreativeVariant } from "@/lib/schemas/canvas";

/**
 * What the canvas agents are told and shown.
 *
 * All four used to receive `{ project }` and nothing else, so the World Builder
 * was asked to work "for the selected creative direction" without ever being
 * given it, and the Director to convert "the selected concept and story arc"
 * with no arc in its input. The prompts were also stripped of the sentence the
 * spec (§9.10–9.13) defines for each, leaving "Return only valid JSON" as half
 * the instruction.
 */

function makeProject(): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "canvas-project",
    title: "Canvas Project",
    concept: "A mural comes to life at night.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "animated",
    tone: "whimsical",
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

const variant = {
  id: "v1",
  projectId: "canvas-project",
  name: "Night Watchman",
  variantType: "story",
  summary: "Told from the caretaker who sees it happen.",
  hook: "Someone has to lock up after the paint moves.",
  storyAngle: "Witness rather than participant",
  visualStyle: "Sodium streetlight and wet pavement",
  strengths: ["intimate"],
  risks: ["slow open"],
  selected: true,
  createdByAgent: "test",
  createdAt: new Date().toISOString(),
} as CreativeVariant;

const cast = [
  { id: "c1", name: "Ada", description: "A caretaker in her sixties." },
] as Character[];

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

describe("the instruction each canvas agent carries", () => {
  it("keeps the sentence the spec defines for it", () => {
    expect(WORLD_BUILDER_SYSTEM).toContain("Define the universe, story rules, recurring locations");
    expect(DIRECTOR_SYSTEM).toContain("Define creative thesis, pacing, emotional arc");
    expect(CINEMATOGRAPHER_SYSTEM).toContain("Specify shot types, lens/framing rules");
    expect(ART_DIRECTOR_SYSTEM).toContain("texture, colour, typography");
  });

  /** A field list produces mood adjectives; a named taxonomy produces framing. */
  it("names the craft vocabulary rather than listing fields", () => {
    expect(CINEMATOGRAPHER_SYSTEM).toMatch(/extreme close-up \(ECU\)/);
    expect(CINEMATOGRAPHER_SYSTEM).toMatch(/key-to-fill ratio/);
    expect(CINEMATOGRAPHER_SYSTEM).toMatch(/motivated by story/);
    expect(DIRECTOR_SYSTEM).toMatch(/what is in the way/);
    expect(WORLD_BUILDER_SYSTEM).toMatch(/script supervisor/);
    expect(ART_DIRECTOR_SYSTEM).toMatch(/period, the geography and the economic register/);
  });

  /**
   * `forbiddenContradictions` are fed straight into negative prompts, where a
   * sentence about what should be true is worse than useless.
   */
  it("tells the World Builder how its contradictions will be used", () => {
    expect(WORLD_BUILDER_SYSTEM).toMatch(/used directly as negative prompts/);
  });
});

describe("what each canvas agent is shown", () => {
  const project = makeProject();
  const ctx = { selectedVariant: variant, cast, plans: {} };

  it("gives the World Builder the direction it is told to build for", async () => {
    const { calls, provider } = recorder();
    await worldBuilderAgent(project, provider, ctx);

    const payload = JSON.parse(calls[0]!.user) as { selectedDirection?: { name: string } };
    expect(payload.selectedDirection?.name).toBe("Night Watchman");
  });

  it("gives the Director the cast and the selected direction", async () => {
    const { calls, provider } = recorder();
    await directorAgent(project, provider, ctx);

    const payload = JSON.parse(calls[0]!.user) as {
      selectedDirection?: unknown;
      cast: { name: string }[];
    };
    expect(payload.selectedDirection).toBeDefined();
    expect(payload.cast[0]?.name).toBe("Ada");
  });

  /** Wardrobe rules that contradict a pinned character are avoidable. */
  it("gives the Art Director the cast", async () => {
    const { calls, provider } = recorder();
    await artDirectorAgent(project, provider, ctx);

    const payload = JSON.parse(calls[0]!.user) as { cast: { name: string }[] };
    expect(payload.cast[0]?.name).toBe("Ada");
  });

  /** Later agents build on approved plans instead of inventing a second mood. */
  it("passes an approved plan on to the agents that run after it", async () => {
    const { calls, provider } = recorder();
    const directorialPlan = {
      projectId: project.id,
      creativeThesis: "Nobody believes the caretaker.",
      pacingStrategy: "slow build",
      emotionalArc: ["unease"],
      performanceDirection: ["still hands"],
      sceneIntent: {},
      approvalNotes: [],
    };

    await cinematographerAgent(project, provider, { ...ctx, plans: { directorialPlan } });

    const payload = JSON.parse(calls[0]!.user) as {
      plans?: { directorialPlan?: { creativeThesis: string } };
    };
    expect(payload.plans?.directorialPlan?.creativeThesis).toBe("Nobody believes the caretaker.");
    expect(calls[0]!.system).toMatch(/Where two sources conflict/);
  });

  it("falls back to the deterministic plan when the model declines", async () => {
    const { provider } = recorder();
    const plan = await cinematographerAgent(project, provider, ctx);
    expect(plan.projectId).toBe(project.id);
    expect(plan.cameraLanguage.length).toBeGreaterThan(0);
  });
});
