import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { storyboardAgent, storyboardSystem } from "@/lib/agents/storyboard-agent";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import { videoPromptSystem } from "@/lib/agents/prompt-agents";
import { videoPromptDirective } from "@/lib/agents/model-directives";
import { directorDialogueDirective } from "@/lib/agents/canvas-agents";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext, AgentProgress } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

const exchange = [
  { character: "Ana", line: "Keep the light on the hinge. If that pin slips again, the whole door comes down on us." },
  { character: "Ben", line: "I have it steady. Turn it slowly, I can see the thread catching now." },
];

function fixture(overrides: Partial<Project> = {}, segmentCount = 2) {
  const project: Project = {
    id: "speech-project",
    title: "The stuck door",
    concept: "Ana works a stuck hinge while Ben holds the light.",
    requestedDurationSeconds: segmentCount * 20,
    segmentSeconds: 20,
    segmentCount,
    generatedDurationSeconds: segmentCount * 20,
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
    createdAt: "2026-10-30T12:00:00Z",
    updatedAt: "2026-10-30T12:00:00Z",
    ...overrides,
  };
  const brief = buildCreativeBrief(project);
  const storyPlan = buildStoryPlan(project);
  const visualBible = buildVisualBible(project);
  const cards: SceneDraft[] = buildSceneDrafts(project, storyPlan, brief, visualBible).map((card) => ({
    ...card,
    dialogueMode: undefined,
    dialogue: exchange,
  }));
  const executions: ArtifactExecution[] = [];
  const ctx: AgentContext = {
    project, brief, storyPlan, visualBible,
    onExecution: (execution) => executions.push(execution),
  };
  return { cards, ctx, executions };
}

function batches(cards: SceneDraft[]) {
  const calls: { system: string; user: Record<string, unknown> }[] = [];
  const provider: PlanningProvider = {
    name: "test-storyboard",
    async generateJson(system, user, schema) {
      const call = { system, user: JSON.parse(user) as Record<string, unknown> };
      calls.push(call);
      const numbers = call.user.segmentNumbers as number[];
      return schema.parse({ scenes: numbers.map((number) => cards[number - 1]) });
    },
  };
  return { provider, calls };
}

describe("the storyboard's part in dialogue", () => {
  it("asks each card for a mode and intent instead of a word count", () => {
    const system = storyboardSystem(20);
    expect(system).toContain('set dialogueMode. Use "full"');
    expect(system).toContain('"brief"');
    expect(system).toContain('Use "silent" when nobody is on screen');
    expect(system).toContain("dialogueIntent");
    expect(system).not.toMatch(/\d+-\d+ dialogue words/);
    expect(system).not.toContain("Any scene with people in it who would plausibly speak gets dialogue");
    expect(storyboardSystem(20, false)).toContain("This project has no dialogue");
  });

  it("tells the video prompt to name every speaker and keeps the speech capacity", () => {
    expect(videoPromptSystem(20)).toContain("Name the speaker before every line");
    expect(videoPromptSystem(20)).toContain("Speech and physical action happen concurrently");
    for (const family of ["ltx", "minimax", "minimax_ref2va"] as const) {
      const directive = videoPromptDirective(family, { segmentSeconds: 20, nativeAudio: true });
      expect(directive).toContain("50 words of speech");
      expect(directive).toContain("capacity, not a target");
    }
  });

  it("asks the Director how each scene is carried by speech only when the project has dialogue", () => {
    expect(directorDialogueDirective({ dialogueRequired: true })).toContain("driven by conversation");
    expect(directorDialogueDirective({ dialogueRequired: false })).toBe("");
  });

  it("makes no dialogue calls of its own and no longer marks the storyboard down for short lines", async () => {
    const { cards, ctx, executions } = fixture();
    for (const card of cards) card.dialogue = [{ character: "Ana", line: "Too short." }];
    const { provider, calls } = batches(cards);
    const result = await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user.speechTargetsBySegment).toBeUndefined();
    expect(result.every((card) => card.dialogueMode === "full")).toBe(true);
    expect(executions.find((e) => e.artifact === "storyboard")).toMatchObject({ source: "llm", status: "ok" });
    expect(executions.some((e) => e.artifact === "storyboard_dialogue")).toBe(false);
  });

  it("drops the lines of a card it marked silent", async () => {
    const { cards, ctx } = fixture();
    cards[1] = { ...cards[1]!, dialogueMode: "silent" };
    const result = await storyboardAgent(ctx, batches(cards).provider);
    expect(result[1]).toMatchObject({ dialogueMode: "silent", dialogue: [] });
    expect(result[0]!.dialogue).toEqual(exchange);
  });

  it("silences every scene of a project without dialogue, whatever the model wrote", async () => {
    const { cards, ctx } = fixture({ dialogueRequired: false });
    const { provider, calls } = batches(cards);
    const result = await storyboardAgent(ctx, provider);
    expect(calls[0]!.system).toContain("This project has no dialogue");
    expect(result.every((card) => card.dialogueMode === "silent" && card.dialogue?.length === 0)).toBe(true);
  });

  it("passes the preceding exchange into the next storyboard batch", async () => {
    const { cards, ctx } = fixture({}, 5);
    const { provider, calls } = batches(cards);
    await storyboardAgent(ctx, provider);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user.previousScene).toMatchObject({ dialogue: cards[3]!.dialogue });
  });
});

describe("dialogue in the storyboard run", () => {
  it("writes dialogue after drafting and before the prompts, with its own progress phase", async () => {
    const { ctx } = fixture();
    const phases: AgentProgress[] = [];
    const executions: ArtifactExecution[] = [];
    const snapshot = await runStoryboardOrchestrator(ctx.project, {
      provider: null,
      onProgress: (progress) => phases.push(progress),
      onExecution: (execution) => executions.push(execution),
    });
    const names = phases.map((p) => p.phase);
    expect(names.indexOf("Writing dialogue")).toBeGreaterThan(names.indexOf("Drafting the scenes"));
    expect(names.indexOf("Writing dialogue")).toBeLessThan(names.indexOf("Writing prompts"));
    expect(executions.filter((e) => e.artifact.endsWith(".dialogue"))).toHaveLength(2);
    expect(snapshot.scenes.every((scene) => scene.dialogueMode === "full")).toBe(true);
  });

  it("skips the pass entirely for a project without dialogue", async () => {
    const { ctx } = fixture({ dialogueRequired: false });
    const phases: string[] = [];
    const snapshot = await runStoryboardOrchestrator(ctx.project, {
      provider: null,
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(phases).not.toContain("Writing dialogue");
    expect(snapshot.scenes.every((scene) => scene.dialogueMode === "silent")).toBe(true);
  });
});

describe("rewriting dialogue on demand", () => {
  const dirs: string[] = [];

  async function isolated() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-dialogue-rewrite-"));
    dirs.push(dir);
    process.env.STORYFORGE_DATA_DIR = dir;
    vi.resetModules();
    const projects = await import("@/lib/services/project-service");
    const rewrite = await import("@/lib/services/dialogue-rewrite-service");
    const project = await projects.createProject({
      concept: "Mara asks Jon to leave before the rain starts.",
      requestedDurationSeconds: 40,
      dialogueRequired: true,
    });
    await projects.generateStoryboard(project.id);
    return { projects, rewrite, projectId: project.id };
  }

  afterEach(async () => {
    delete process.env.STORYFORGE_DATA_DIR;
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("changes the chosen scene's dialogue and video prompt, and leaves its stills alone", async () => {
    const { projects, rewrite, projectId } = await isolated();
    const before = (await projects.getProjectRecord(projectId)).storyboard!.scenes;
    const target = before[0]!;
    const result = await rewrite.rewriteDialogue(projectId, {
      sceneIds: [target.id], modeOverride: "silent", rewriteVideoPrompts: true,
    });
    expect(result.updatedSceneIds).toEqual([target.id]);
    expect(result.promptsRewritten).toBe(true);
    const after = result.record.storyboard!.scenes;
    expect(after[0]).toMatchObject({ dialogueMode: "silent", dialogue: [] });
    expect(after[0]!.prompts.startFramePrompt).toBe(target.prompts.startFramePrompt);
    expect(after[0]!.prompts.endFramePrompt).toBe(target.prompts.endFramePrompt);
    expect(after[0]!.prompts.videoPromptSegment).not.toBe(target.prompts.videoPromptSegment);
    expect(after[1]).toEqual(before[1]);
    expect(result.record.history?.at(-2)?.action).toBe("scene.dialogue_rewritten");
  });

  it("finds nothing to fill when every speaking scene already fits", async () => {
    const { rewrite, projectId } = await isolated();
    const result = await rewrite.rewriteDialogue(projectId, { onlyUnderCovered: true });
    expect(result.updatedSceneIds).toEqual([]);
    expect(result.skippedSceneIds).toHaveLength(2);
  });

  it("rejects an unknown scene and an over-long note", async () => {
    const { rewrite, projectId } = await isolated();
    await expect(rewrite.rewriteDialogue(projectId, { sceneIds: ["nope"] })).rejects.toThrow(/not found/);
    await expect(rewrite.rewriteDialogue(projectId, { instruction: "x".repeat(501) })).rejects.toThrow();
  });
});
