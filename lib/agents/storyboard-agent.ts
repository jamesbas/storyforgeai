import { z } from "zod";
import { sceneDraftSchema, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const STORYBOARD_SYSTEM =
  "You are the Storyboard Agent. Create exactly one scene card per 20-second segment. " +
  "Each scene must include scene objective, story beat, visual description, action, camera " +
  "movement, transition in/out, continuity notes, and optional narration/dialogue/music/SFX " +
  "notes. Do not write image prompts or video prompts yet. Return only valid JSON.";

const sceneDraftsSchema = z.object({ scenes: z.array(sceneDraftSchema) });

export async function storyboardAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<SceneDraft[]> {
  const brief = ctx.brief;
  const storyPlan = ctx.storyPlan;
  const visualBible = ctx.visualBible;
  if (!brief || !storyPlan || !visualBible) {
    throw new Error("storyboardAgent requires brief, storyPlan and visualBible in context");
  }

  if (provider) {
    const user = JSON.stringify({ project: ctx.project, brief, storyPlan, visualBible });
    const result = await provider.generateJson(STORYBOARD_SYSTEM, user, sceneDraftsSchema);
    if (result && result.scenes.length === ctx.project.segmentCount) {
      return result.scenes;
    }
  }
  return buildSceneDrafts(ctx.project, storyPlan, brief, visualBible);
}
