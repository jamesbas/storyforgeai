import { visualBibleSchema, type VisualBible } from "@/lib/schemas/agents";
import { buildVisualBible } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { plainClothing } from "@/lib/agents/clothing-wording";
import { conceptVisualsDirective, conceptVisualsPayload } from "@/lib/agents/concept-visuals";
import { planningPayload, precedenceDirective } from "@/lib/agents/creative-context";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import type { Character } from "@/lib/schemas/character";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const VISUAL_BIBLE_SYSTEM =
  "You are the Visual Bible Agent. Create a continuity guide that keeps all generated " +
  "images and videos visually consistent. Define characters, locations, props, color " +
  "palette, lighting, camera style, and negative rules. Return only valid JSON matching " +
  "the VisualBible schema." +
  // The bible's description of an unpinned character is what every later prompt
  // reads. "An open shirt that reveals his biceps" was drawn, in every frame, as
  // no shirt at all, and a patron became a naked man in a club full of clothed
  // ones. An image model renders the skin those words point at.
  " For every character who is not in the supplied cast, state what they wear as complete, " +
  "specific garments with colours and fastenings — \"a black short-sleeved shirt, buttoned, and " +
  "dark jeans\" — and never describe clothing as open, unbuttoned, revealing or worn over a " +
  "bare chest unless the concept says that is the point.";

export async function visualBibleAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<VisualBible> {
  const cast = ctx.cast ?? [];

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

  const { value, execution } = await executeArtifact<VisualBible>({
    artifact: "visual_bible",
    scope: "project",
    correlationId: ctx.correlationId,
    promptVersion: PROMPT_VERSIONS.visualBible,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: ctx.onExecution,
    llm: provider
      ? providerCall(
          provider,
          VISUAL_BIBLE_SYSTEM +
            castSystemDirective(cast) +
            precedenceDirective(cast, ctx.plans) +
            conceptVisualsDirective(ctx.conceptVisuals),
          user,
          visualBibleSchema,
          { systemPromptScope: "storyboard" },
        )
      : undefined,
    fallback: () => buildVisualBible(ctx.project, cast, ctx.plans),
  });

  return execution.source === "llm"
    ? withPinnedCast(withPlainClothing({ ...value, projectId: ctx.project.id }, cast), cast)
    : value;
}

/**
 * Re-word clothing the renderer would draw as none, for everyone who is not in
 * the cast. A pinned character's description is the library's and is not touched.
 */
function withPlainClothing(bible: VisualBible, cast: readonly Character[]): VisualBible {
  const pinned = new Set(cast.map((c) => c.name.toLowerCase()));
  return {
    ...bible,
    characters: bible.characters.map((character) =>
      pinned.has(character.name.toLowerCase())
        ? character
        : { ...character, description: plainClothing(character.description) },
    ),
  };
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
