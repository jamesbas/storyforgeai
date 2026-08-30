import { describe, expect, it } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { computeSegmentation } from "@/lib/duration";
import { variantExplorerAgent } from "@/lib/agents/canvas-agents";
import { intakeAgent } from "@/lib/agents/intake-agent";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import type { GenerateOptions, PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";

/**
 * The scopes exist because the three workflows want contradictory instructions:
 * render rules handed to a narrative agent make it write prompts instead of the
 * scene card it was asked for.
 */
function project(): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "prompt-routing",
    title: "Prompt Routing",
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "urgent",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "keyframes_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as Project;
}

function recorder() {
  const scopes: (string | undefined)[] = [];
  const provider: PlanningProvider = {
    name: "capture",
    generateJson: async <T,>(
      _system: string,
      _user: string,
      _schema: ZodType<T, ZodTypeDef, unknown>,
      options?: GenerateOptions,
    ) => {
      scopes.push(options?.systemPromptScope);
      return null as T | null;
    },
  };
  return { scopes, provider };
}

describe("system prompt workflow routing", () => {
  it("gives narrative planning and Canvas planning their own scopes", async () => {
    const { scopes, provider } = recorder();
    const input = project();

    await intakeAgent({ project: input }, provider);
    await variantExplorerAgent(input, provider);

    expect(scopes).toEqual(["storyboard", "agentic_canvas"]);
  });

  /** The only agents that write the text sent to an image or video model. */
  it("scopes every render-prompt call to render_prompts", async () => {
    const { scopes, provider } = recorder();
    const input = project();
    const brief = buildCreativeBrief(input);
    const drafts = buildSceneDrafts(input, buildStoryPlan(input), brief, buildVisualBible(input));

    await attachScenePrompts(input, drafts, provider);

    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes)).toEqual(new Set(["render_prompts"]));
  });
});