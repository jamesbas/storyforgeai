import { describe, expect, it } from "vitest";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { countWords, dialogueWordTargets } from "@/lib/agents/media-prompt-spec";
import { storyboardAgent, storyboardSystem } from "@/lib/agents/storyboard-agent";
import { videoPromptSystem } from "@/lib/agents/prompt-agents";
import { videoPromptDirective } from "@/lib/agents/model-directives";
import type { GenerateOptions, PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

const shortLine = "Keep the light steady.";
const revisedLine =
  "Keep the light steady on that hinge. The pin is slipping, and if I lose my grip, this whole door will close before either of us can safely get through together.";
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

function fixture(finalTrimSeconds = 0, segmentCount = 2) {
  const project: Project = {
    id: "speech-project",
    title: "The stuck door",
    concept: "Ana works a stuck hinge while Ben holds the light.",
    requestedDurationSeconds: segmentCount * 20 - finalTrimSeconds,
    segmentSeconds: 20,
    segmentCount,
    generatedDurationSeconds: segmentCount * 20,
    finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "tense",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: true,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: "2026-10-30T12:00:00Z",
    updatedAt: "2026-10-30T12:00:00Z",
  };
  const brief = buildCreativeBrief(project);
  const storyPlan = buildStoryPlan(project);
  const visualBible = buildVisualBible(project);
  const cards = buildSceneDrafts(project, storyPlan, brief, visualBible).map((card) => ({
    ...card,
    actionDescription: "Ana keeps turning the hinge while Ben holds the light steady.",
    dialogue: [{ character: "Ana", line: shortLine }],
  }));
  const executions: ArtifactExecution[] = [];
  const ctx: AgentContext = {
    project, brief, storyPlan, visualBible,
    onExecution: (execution) => executions.push(execution),
  };
  return { cards, ctx, executions };
}

type Call = { system: string; user: Record<string, unknown>; options?: GenerateOptions };

function writer(cards: SceneDraft[], revise: (call: Call, attempt: number) => unknown) {
  const calls: Call[] = [];
  let attempts = 0;
  const provider: PlanningProvider = {
    name: "test-writer",
    async generateJson(_system, user, schema, options) {
      const call = { system: _system, user: JSON.parse(user), options };
      calls.push(call);
      if (_system.startsWith("You are the Storyboard Dialogue Writer")) {
        const answer = revise(call, attempts++);
        return answer === null ? null : schema.parse(answer);
      }
      const numbers = call.user.segmentNumbers as number[];
      return schema.parse({ scenes: numbers.map((number) => cards[number - 1]) });
    },
  };
  return { provider, calls };
}

function revisions(call: Call, line = revisedLine) {
  const requested = call.user.scenes as { sceneNumber: number }[];
  return {
    scenes: requested.map(({ sceneNumber }) => ({
      sceneNumber,
      dialogue: [{ character: "Ana", line }],
    })),
  };
}

describe("duration-aware dialogue authoring", () => {
  it("uses a 25-word floor and 30-35-word target for 20 seconds", () => {
    expect(dialogueWordTargets(20)).toEqual({
      minimum: 25, targetMin: 30, targetMax: 35, maximum: 50,
    });
    expect(dialogueWordTargets(10)).toEqual({
      minimum: 13, targetMin: 15, targetMax: 18, maximum: 25,
    });
  });

  it("asks for grounded exchanges and action that continues under speech", () => {
    const system = storyboardSystem(20);
    expect(system).toContain("30-35 dialogue words");
    expect(system).toContain("at least 25");
    expect(system).toContain("objective, visible action, objects");
    expect(system).toContain("a reply should respond");
    expect(system).toContain("Keep delivery and action directions outside");
    expect(videoPromptSystem(20)).toContain("Speech and physical action happen concurrently");
    for (const family of ["ltx", "minimax", "minimax_ref2va"] as const) {
      const directive = videoPromptDirective(family, { segmentSeconds: 20, nativeAudio: true });
      expect(directive).toContain("50 words of speech");
      expect(directive).toContain("capacity, not a target");
      expect(directive).toContain("ongoing physical action");
    }
  });

  it("revises only underwritten speaking cards, preserving every other scene field", async () => {
    const { cards, ctx, executions } = fixture();
    cards[1]!.dialogue[0]!.line = revisedLine;
    const originals = structuredClone(cards);
    const { provider, calls } = writer(cards, (call) => revisions(call));
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(2);
    const repair = calls[1]!;
    expect(repair.options?.systemPromptScope).toBe("storyboard");
    expect((repair.user.scenes as unknown[])).toHaveLength(1);
    expect(result[0]!.dialogue?.[0]?.line).toBe(revisedLine);
    expect(countWords(result[0]!.dialogue!.map((line) => line.line).join(" "))).toBeGreaterThanOrEqual(25);
    for (let i = 0; i < cards.length; i += 1) {
      expect(result[i]).toEqual({ ...originals[i], dialogue: result[i]!.dialogue });
    }
    expect(result[1]!.dialogue).toEqual(originals[1]!.dialogue);
    expect(executions.find((entry) => entry.artifact === "storyboard_dialogue")).toMatchObject({
      source: "llm", status: "ok",
    });
  });

  it.each([25, 50])("accepts %i words without a revision", async (count) => {
    const { cards, ctx } = fixture();
    for (const card of cards) card.dialogue[0]!.line = words(count);
    const { provider, calls } = writer(cards, () => {
      throw new Error("No revision expected");
    });
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(1);
    expect(result[0]!.dialogue?.[0]?.line).toBe(words(count));
  });

  it.each([24, 51])("revises %i words rather than accepting an out-of-range script", async (count) => {
    const { cards, ctx } = fixture();
    for (const card of cards) card.dialogue[0]!.line = words(count);
    const { provider, calls } = writer(cards, (call) => revisions(call));
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(2);
    expect(result.every((card) => card.dialogue?.[0]?.line === revisedLine)).toBe(true);
  });

  it("preserves intentionally wordless cards", async () => {
    const { cards, ctx } = fixture();
    for (const card of cards) card.dialogue = [];
    const { provider, calls } = writer(cards, () => {
      throw new Error("Silent scenes must not be rewritten");
    });
    expect((await storyboardAgent(ctx, provider)).every((card) => !card.dialogue?.length)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("uses the final trimmed duration rather than requiring 20 seconds of dialogue", async () => {
    const { cards, ctx } = fixture(10);
    cards[0]!.dialogue[0]!.line = revisedLine;
    cards[1]!.dialogue[0]!.line = words(13);
    const { provider, calls } = writer(cards, () => {
      throw new Error("The trimmed scene already meets its floor");
    });
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(1);
    expect(result[1]!.trimAtEndSeconds).toBe(10);
    expect(calls[0]!.user.speechTargetsBySegment).toMatchObject({
      "2": { seconds: 10, minimum: 13, targetMin: 15, targetMax: 18 },
    });
  });

  it("bounds retries and keeps original lines with degraded provenance if still too short", async () => {
    const { cards, ctx, executions } = fixture();
    const { provider, calls } = writer(cards, (call) => revisions(call, "Not yet."));
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.user.previousAnswer).toBeDefined();
    expect(result[0]!.dialogue?.[0]?.line).toBe(shortLine);
    expect(executions.find((entry) => entry.artifact === "storyboard_dialogue")).toMatchObject({
      source: "hybrid", status: "degraded", fallbackReason: "invalid_set",
    });
    expect(executions.find((entry) => entry.artifact === "storyboard")).toMatchObject({
      source: "hybrid", status: "degraded", fallbackReason: "invalid_set",
    });
    expect(executions.find((entry) => entry.artifact === "storyboard_dialogue")?.detail)
      .not.toContain(shortLine);
  });

  it("keeps the original scene when the revision request fails", async () => {
    const { cards, ctx, executions } = fixture();
    const { provider } = writer(cards, () => {
      throw new Error("The model is unavailable");
    });
    const result = await storyboardAgent(ctx, provider);
    expect(result[0]!.dialogue?.[0]?.line).toBe(shortLine);
    expect(executions.find((entry) => entry.artifact === "storyboard_dialogue")).toMatchObject({
      status: "degraded", fallbackReason: "request_failed",
    });
  });

  it.each(["new speaker", "silence", "duplicate scene"])("rejects a revision that introduces %s", async (fault) => {
    const { cards, ctx } = fixture();
    const { provider } = writer(cards, (call) => {
      const answer = revisions(call);
      if (fault === "new speaker") answer.scenes[0]!.dialogue[0]!.character = "Stranger";
      if (fault === "silence") answer.scenes[0]!.dialogue = [];
      if (fault === "duplicate scene") answer.scenes.push(answer.scenes[0]!);
      return answer;
    });
    const result = await storyboardAgent(ctx, provider);
    expect(result[0]!.dialogue?.[0]?.line).toBe(shortLine);
  });

  it("retries only unresolved scenes after a partial revision", async () => {
    const { cards, ctx } = fixture();
    const { provider, calls } = writer(cards, (call, attempt) => {
      const answer = revisions(call);
      if (attempt === 0) answer.scenes = answer.scenes.slice(0, 1);
      return answer;
    });
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.user.scenes).toMatchObject([{ sceneNumber: 2 }]);
    expect(result.every((card) => card.dialogue?.[0]?.line === revisedLine)).toBe(true);
  });

  it("counts an exchange across speakers and retains each speaker", async () => {
    const { cards, ctx } = fixture();
    cards[0]!.dialogue.push({ character: "Ben", line: "I have it." });
    cards[1]!.dialogue[0]!.line = revisedLine;
    const exchange = [
      { character: "Ana", line: "Keep the light on the hinge. If that pin slips, the whole door comes down." },
      { character: "Ben", line: "I have it steady. Keep turning while I brace this side; we are almost through." },
    ];
    const { provider } = writer(cards, () => ({
      scenes: [{ sceneNumber: 1, dialogue: exchange, actionDescription: "A different action" }],
    }));
    const result = await storyboardAgent(ctx, provider);
    expect(result[0]!.dialogue).toEqual(exchange);
    expect(result[0]!.actionDescription).toBe(cards[0]!.actionDescription);
    expect(countWords(exchange.map((line) => line.line).join(" "))).toBeGreaterThanOrEqual(25);
  });

  it("retains accepted revisions if the next attempt fails", async () => {
    const { cards, ctx, executions } = fixture();
    const { provider } = writer(cards, (call, attempt) => {
      if (attempt > 0) throw new Error("The model became unavailable");
      const answer = revisions(call);
      answer.scenes = answer.scenes.slice(0, 1);
      return answer;
    });
    const result = await storyboardAgent(ctx, provider);
    expect(result[0]!.dialogue?.[0]?.line).toBe(revisedLine);
    expect(result[1]!.dialogue?.[0]?.line).toBe(shortLine);
    expect(executions.find((entry) => entry.artifact === "storyboard")).toMatchObject({
      source: "hybrid", status: "degraded",
    });
  });

  it("passes the preceding exchange into the next storyboard batch", async () => {
    const { cards, ctx } = fixture(0, 5);
    for (const card of cards) card.dialogue[0]!.line = revisedLine;
    const { provider, calls } = writer(cards, () => {
      throw new Error("No revision expected");
    });
    await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user.previousScene).toMatchObject({ dialogue: cards[3]!.dialogue });
  });
});
