import { visualBibleSchema, type VisualBible } from "@/lib/schemas/agents";
import { buildVisualBible } from "@/lib/agents/mock-agents";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const VISUAL_BIBLE_SYSTEM =
  "You are the Visual Bible Agent. Create a continuity guide that keeps all generated " +
  "images and videos visually consistent. Define characters, locations, props, color " +
  "palette, lighting, camera style, and negative rules. Return only valid JSON matching " +
  "the VisualBible schema.";

export async function visualBibleAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<VisualBible> {
  if (provider) {
    const user = JSON.stringify({ project: ctx.project, brief: ctx.brief });
    const result = await provider.generateJson(VISUAL_BIBLE_SYSTEM, user, visualBibleSchema);
    if (result) return { ...result, projectId: ctx.project.id };
  }
  return buildVisualBible(ctx.project);
}
