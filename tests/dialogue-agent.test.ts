import { describe, expect, it } from "vitest";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { allowedSpeakers, writeSceneDialogue, type DialogueContext } from "@/lib/agents/dialogue-agent";
import { countSpokenWords, lintDialogue } from "@/lib/agents/media-prompt-spec";
import type { GenerateOptions, PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import { sceneDraftSchema } from "@/lib/schemas/storyboard";
import type { ArtifactExecution } from "@/lib/schemas/provenance";
import type { DialogueLine } from "@/lib/schemas/audio";

const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "dialogue-project",
    title: "The stuck door",
    concept: "Ana works a stuck hinge while Ben holds the light.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: 3,
    generatedDurationSeconds: 60,
    finalTrimSeconds: 0,
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
    createdAt: "2026-11-24T12:00:00Z",
    updatedAt: "2026-11-24T12:00:00Z",
    ...overrides,
  };
}

/** Three 20-second scenes with Ana and Ben in shot and a short draft from Ana alone. */
function scenes(p = project()): SceneDraft[] {
  return buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), buildVisualBible(p)).map((scene) => ({
    ...scene,
    charactersPresent: [],
    frameVisibility: { start: ["Ana", "Ben"], end: ["Ana", "Ben"] },
    actionDescription: "Ana keeps turning the hinge while Ben holds the light steady.",
    dialogueMode: "full",
    dialogue: [{ character: "Ana", line: "Keep the light steady." }],
  }));
}

type Call = { system: string; user: Record<string, unknown>; options?: GenerateOptions };

function writer(answer: (call: Call, attempt: number) => unknown) {
  const calls: Call[] = [];
  const provider: PlanningProvider = {
    name: "test-writer",
    async generateJson(system, user, schema, options) {
      const call = { system, user: JSON.parse(user) as Record<string, unknown>, options };
      calls.push(call);
      const value = answer(call, calls.length - 1);
      return value === null ? null : schema.parse(value);
    },
  };
  return { provider, calls };
}

function context(provider: PlanningProvider | null, p = project()) {
  const executions: ArtifactExecution[] = [];
  const ctx: DialogueContext = { project: p, provider, onExecution: (e) => executions.push(e) };
  return { ctx, executions };
}

/** A 32-word exchange between Ana and Ben: above the 30-word floor for 20 seconds. */
const exchange: DialogueLine[] = [
  { character: "Ana", line: "Keep the light on the hinge. If that pin slips again, the whole door comes down on us." },
  { character: "Ben", line: "I have it steady. Turn it slowly, I can see the thread catching now." },
];

describe("the Dialogue Writer", () => {
  it("leaves silent scenes silent without a call", async () => {
    const drafts = scenes().map((scene) => ({ ...scene, dialogueMode: "silent" as const }));
    const { provider, calls } = writer(() => { throw new Error("No call expected"); });
    const result = await writeSceneDialogue(drafts, context(provider).ctx);
    expect(calls).toHaveLength(0);
    expect(result.scenes.every((scene) => scene.dialogueMode === "silent" && !scene.dialogue?.length)).toBe(true);
  });

  it("accepts a draft that already fits its mode without a call", async () => {
    const drafts = scenes().map((scene) => ({ ...scene, dialogue: exchange }));
    const { provider, calls } = writer(() => { throw new Error("No call expected"); });
    const { ctx, executions } = context(provider);
    const result = await writeSceneDialogue(drafts, ctx);
    expect(calls).toHaveLength(0);
    expect(result.outcomes[drafts[0]!.id]).toBe("draft");
    expect(executions.find((e) => e.artifact === `${drafts[0]!.id}.dialogue`)?.detail).toMatch(/^draft accepted · full · 32w/);
  });

  it("tells the next attempt exactly why the last one was rejected", async () => {
    const drafts = scenes().slice(0, 1);
    const { provider, calls } = writer((_call, attempt) => ({
      dialogue: attempt === 0 ? [{ character: "Ana", line: words(21) }] : exchange,
    }));
    const result = await writeSceneDialogue(drafts, context(provider).ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain("34-42 spoken words");
    expect(calls[0]!.user.targets).toMatchObject({ minimum: 30, targetMin: 34, targetMax: 42, maximum: 50 });
    expect(calls[1]!.user.revisionNeeded).toMatch(/21 spoken words \(~8\.4s\).*34-42 spoken words \(at least 30, at most 50\)/);
    expect(result.outcomes[drafts[0]!.id]).toBe("retry");
    expect(result.scenes[0]!.dialogue).toEqual(exchange);
  });

  it("lets a second visible person speak, which the draft's speakers did not include", async () => {
    const drafts = scenes().slice(0, 1);
    const { provider } = writer(() => ({ dialogue: exchange }));
    const result = await writeSceneDialogue(drafts, context(provider).ctx);
    expect(result.scenes[0]!.dialogue!.map((line) => line.character)).toEqual(["Ana", "Ben"]);
  });

  it("matches speakers case-insensitively and rejects anyone not in the scene", async () => {
    const drafts = scenes().slice(0, 1);
    const { provider, calls } = writer((_call, attempt) => ({
      dialogue: attempt === 0
        ? [{ character: "Stranger", line: words(36) }]
        : exchange.map((line) => ({ ...line, character: line.character.toLowerCase() })),
    }));
    const result = await writeSceneDialogue(drafts, context(provider).ctx);
    expect(calls[1]!.user.revisionNeeded).toContain("not in the scene: Stranger. Use only: Ana, Ben");
    expect(result.scenes[0]!.dialogue!.map((line) => line.character)).toEqual(["Ana", "Ben"]);
  });

  it("keeps the closest usable attempt rather than reverting to a short draft", async () => {
    const drafts = scenes().slice(0, 1);
    const lengths = [28, 10, 12];
    const { provider } = writer((_call, attempt) => ({ dialogue: [{ character: "Ana", line: words(lengths[attempt]!) }] }));
    const { ctx, executions } = context(provider);
    const result = await writeSceneDialogue(drafts, ctx);
    expect(countSpokenWords(result.scenes[0]!.dialogue!)).toBe(28);
    expect(result.outcomes[drafts[0]!.id]).toBe("best_effort");
    expect(executions.find((e) => e.artifact === `${drafts[0]!.id}.dialogue`)).toMatchObject({
      source: "hybrid", status: "degraded", fallbackReason: "invalid_set",
    });
    expect(result.warnings[drafts[0]!.id]?.[0]).toContain("Aim for 34-42");
  });

  it("keeps the draft when the model fails, and never empties a speaking scene", async () => {
    const drafts = scenes().slice(0, 1);
    const { provider } = writer(() => { throw new Error("The model is unavailable"); });
    const { ctx, executions } = context(provider);
    const result = await writeSceneDialogue(drafts, ctx);
    expect(result.scenes[0]!.dialogue).toEqual(drafts[0]!.dialogue);
    expect(executions[0]).toMatchObject({ status: "degraded", fallbackReason: "request_failed" });
  });

  it("accepts a demotion when the mode is not locked, and refuses it when it is", async () => {
    const drafts = scenes().slice(0, 1);
    const brief = { dialogueMode: "brief", dialogue: [{ character: "Ben", line: "Hold it there." }] };
    const free = writer(() => brief);
    const demoted = await writeSceneDialogue(drafts, context(free.provider).ctx);
    expect(demoted.scenes[0]).toMatchObject({ dialogueMode: "brief", dialogue: brief.dialogue });

    const locked = writer(() => brief);
    const kept = await writeSceneDialogue(drafts, context(locked.provider).ctx, { modeOverride: "full", force: true });
    expect(locked.calls).toHaveLength(3);
    expect(locked.calls[0]!.system).toContain("The creator chose this mode; keep it.");
    expect(kept.scenes[0]!.dialogueMode).toBe("full");
    expect(kept.scenes[0]!.dialogue).toEqual(drafts[0]!.dialogue);
  });

  it("never promotes a brief scene during automatic writing", async () => {
    const drafts = scenes().slice(0, 1).map((scene) => ({ ...scene, dialogueMode: "brief" as const, dialogue: [] }));
    const { provider } = writer(() => ({ dialogueMode: "full", dialogue: [{ character: "Ana", line: "Down, now!" }] }));
    const result = await writeSceneDialogue(drafts, context(provider).ctx);
    expect(result.scenes[0]!.dialogueMode).toBe("brief");
  });

  it("hands each scene the finished lines before it and the beat after it", async () => {
    const drafts = scenes();
    const { provider, calls } = writer(() => ({ dialogue: exchange }));
    await writeSceneDialogue(drafts, context(provider).ctx);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.user.previousSceneDialogue).toBeUndefined();
    expect(calls[1]!.user.previousSceneDialogue).toEqual(exchange);
    expect(calls[1]!.user.nextSceneBeat).toBe(drafts[2]!.storyBeat);
    expect(calls[1]!.user.roughDraft).toEqual(drafts[1]!.dialogue);
  });

  it("uses the final scene's trimmed length", async () => {
    const p = project({ finalTrimSeconds: 10, requestedDurationSeconds: 50 });
    const drafts = scenes(p);
    const { provider, calls } = writer(() => ({ dialogue: [{ character: "Ana", line: words(19) }] }));
    await writeSceneDialogue(drafts, context(provider, p).ctx, { only: new Set([drafts[2]!.id]) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user.targets).toMatchObject({ seconds: 10, targetMin: 17, targetMax: 21 });
  });

  it("passes the creator's note as data, and rewrites only the scenes asked for", async () => {
    const drafts = scenes().map((scene) => ({ ...scene, dialogue: exchange }));
    const { provider, calls } = writer(() => ({ dialogue: exchange }));
    await writeSceneDialogue(drafts, context(provider).ctx, {
      only: new Set([drafts[1]!.id]), force: true, instruction: "make it tenser",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toMatchObject({ creatorNote: "make it tenser", scene: { sceneNumber: 2 } });
    expect(calls[0]!.system).not.toContain("make it tenser");
  });
});

describe("who may speak", () => {
  it("prefers the cast spelling and ignores a leading article", () => {
    const [scene] = scenes();
    const speakers = allowedSpeakers(
      { ...scene!, frameVisibility: { start: ["the bartender", "ana"], end: [] } },
      [{ id: "c1", name: "Ana", description: "A locksmith in her forties." } as never],
    );
    expect(speakers.resolve("Bartender")).toBe("the bartender");
    expect(speakers.resolve("ANA")).toBe("Ana");
    expect(speakers.resolve("Stranger")).toBeUndefined();
    expect(speakers.notes.Ana).toContain("locksmith");
  });
});

describe("a model-written dialogue mode", () => {
  it("is read leniently, so one odd value cannot reject a whole batch of cards", () => {
    const [card] = scenes();
    const parse = (dialogueMode: unknown, dialogueIntent?: unknown) =>
      sceneDraftSchema.parse({ ...card, dialogueMode, dialogueIntent });
    expect(parse("Short").dialogueMode).toBe("brief");
    expect(parse("none").dialogueMode).toBe("silent");
    expect(parse("FULL").dialogueMode).toBe("full");
    expect(parse("sometimes").dialogueMode).toBeUndefined();
    expect(parse(null).dialogueMode).toBeUndefined();
    expect(parse("full", "x".repeat(600)).dialogueIntent).toHaveLength(400);
  });
});

describe("deterministic dialogue", () => {
  it.each([8, 10, 20])("fills a %is scene to its full-mode target", (seconds) => {
    const p = project({ segmentSeconds: seconds, segmentCount: 2, requestedDurationSeconds: seconds * 2, generatedDurationSeconds: seconds * 2 });
    for (const scene of buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), buildVisualBible(p))) {
      expect(scene.dialogueMode).toBe("full");
      expect(lintDialogue(scene.dialogue ?? [], seconds, { mode: scene.dialogueMode })).toEqual([]);
    }
  });

  it("writes silent scenes for a project without dialogue", () => {
    const p = project({ dialogueRequired: false });
    const drafts = buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), buildVisualBible(p));
    expect(drafts.every((scene) => scene.dialogueMode === "silent" && !scene.dialogue?.length)).toBe(true);
  });
});
