import { visualBibleSchema, type VisualBible } from "@/lib/schemas/agents";
import { buildVisualBible } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { conceptVisualsDirective, conceptVisualsPayload } from "@/lib/agents/concept-visuals";
import { planningPayload, precedenceDirective } from "@/lib/agents/creative-context";
import type { Character } from "@/lib/schemas/character";
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
  const cast = ctx.cast ?? [];

  if (provider) {
    // The planning agents get the plan documents whole: they run once and emit
    // prose, so context budget is not the constraint it is for render prompts.
    const conceptVisuals = conceptVisualsPayload(ctx.conceptVisuals);
    const user = JSON.stringify({
      project: ctx.project,
      brief: ctx.brief,
      cast,
      plans: planningPayload(ctx.plans),
      ...(conceptVisuals ? { conceptVisuals } : {}),
    });
    const result = await provider.generateJson(
      VISUAL_BIBLE_SYSTEM +
        castSystemDirective(cast) +
        precedenceDirective(cast, ctx.plans) +
        conceptVisualsDirective(ctx.conceptVisuals),
      user,
      visualBibleSchema,
    );
    if (result) return withPinnedCast({ ...result, projectId: ctx.project.id }, cast);
  }
  return buildVisualBible(ctx.project, cast, ctx.plans);
}

/**
 * Guarantee the pinned cast survives into the bible even if the model dropped,
 * renamed or paraphrased a character. The library description wins on conflict —
 * that is the entire contract of pinning one.
 */
function withPinnedCast(bible: VisualBible, cast: readonly Character[]): VisualBible {
  if (cast.length === 0) return bible;
  const pinned = cast.map((c) => ({ name: c.name, description: c.description }));
  const pinnedNames = new Set(pinned.map((c) => c.name.toLowerCase()));
  const rest = bible.characters.filter((c) => !pinnedNames.has(c.name.toLowerCase()));
  return { ...bible, characters: [...pinned, ...rest] };
}
