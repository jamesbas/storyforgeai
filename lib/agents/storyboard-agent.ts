import { z } from "zod";
import { sceneDraftSchema, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { planningPayload, precedenceDirective } from "@/lib/agents/creative-context";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const storyboardSystem = (segmentSeconds: number) =>
  `You are the Storyboard Agent. Create exactly one scene card per ${segmentSeconds}-second ` +
  "segment. Each scene must include scene objective, story beat, visual description, action, " +
  "camera movement, transition in/out, continuity notes, and optional narration/dialogue/" +
  "music/SFX notes. Scope the action to what can actually happen in " +
  `${segmentSeconds} seconds. Do not write image prompts or video prompts yet. ` +
  "Return only valid JSON.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORYBOARD_SYSTEM = storyboardSystem(SEGMENT_SECONDS);

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
    const cast = ctx.cast ?? [];
    const user = JSON.stringify({
      project: ctx.project,
      brief,
      storyPlan,
      visualBible,
      cast,
      plans: planningPayload(ctx.plans),
    });
    const result = await provider.generateJson(
      storyboardSystem(ctx.project.segmentSeconds) +
        castSystemDirective(cast) +
        precedenceDirective(cast, ctx.plans),
      user,
      sceneDraftsSchema,
    );
    if (result && result.scenes.length === ctx.project.segmentCount) {
      return result.scenes;
    }
  }
  return buildSceneDrafts(ctx.project, storyPlan, brief, visualBible, ctx.cast ?? [], ctx.plans);
}
