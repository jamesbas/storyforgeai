import { storyPlanSchema, type StoryPlan } from "@/lib/schemas/agents";
import { buildStoryPlan } from "@/lib/agents/mock-agents";
import { creativeModeDirective } from "@/lib/agents/look";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

/**
 * Segment length is configurable, so it is interpolated rather than baked in:
 * telling the model "20-second segments" for an 8s project produces beats with
 * far too much action for the clip that actually gets rendered.
 */
export const storyArchitectSystem = (segmentSeconds: number) =>
  "You are the Story Architect Agent. Create a complete narrative plan sized to the " +
  `requested duration. The video will be generated in ${segmentSeconds}-second segments. ` +
  "Create a story arc that can be divided cleanly into the required number of segments. " +
  "Return JSON with title, logline, emotional progression, and per-segment story beat " +
  "summaries.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORY_ARCHITECT_SYSTEM = storyArchitectSystem(SEGMENT_SECONDS);

export async function storyArchitectAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<StoryPlan> {
  if (provider) {
    const user = JSON.stringify({ project: ctx.project, brief: ctx.brief });
    const result = await provider.generateJson(
      storyArchitectSystem(ctx.project.segmentSeconds) + creativeModeDirective(ctx.project),
      user,
      storyPlanSchema,
    );
    // Enforce one beat per segment even if the model returned a different count.
    if (result && result.segmentBeats.length === ctx.project.segmentCount) {
      return { ...result, projectId: ctx.project.id };
    }
  }
  return buildStoryPlan(ctx.project);
}
