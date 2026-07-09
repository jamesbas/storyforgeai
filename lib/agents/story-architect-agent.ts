import { storyPlanSchema, type StoryPlan } from "@/lib/schemas/agents";
import { buildStoryPlan } from "@/lib/agents/mock-agents";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const STORY_ARCHITECT_SYSTEM =
  "You are the Story Architect Agent. Create a complete narrative plan sized to the " +
  "requested duration. The video will be generated in 20-second segments. Create a story " +
  "arc that can be divided cleanly into the required number of segments. Return JSON with " +
  "title, logline, emotional progression, and per-segment story beat summaries.";

export async function storyArchitectAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<StoryPlan> {
  if (provider) {
    const user = JSON.stringify({ project: ctx.project, brief: ctx.brief });
    const result = await provider.generateJson(STORY_ARCHITECT_SYSTEM, user, storyPlanSchema);
    // Enforce one beat per segment even if the model returned a different count.
    if (result && result.segmentBeats.length === ctx.project.segmentCount) {
      return { ...result, projectId: ctx.project.id };
    }
  }
  return buildStoryPlan(ctx.project);
}
