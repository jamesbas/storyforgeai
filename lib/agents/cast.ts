import type { Character } from "@/lib/schemas/character";

/**
 * Turns library characters into prompt fragments.
 *
 * Character consistency across independently generated clips is the hardest
 * part of this pipeline: each scene is a separate render, so the only thing
 * holding a face together is that every prompt describes it identically. These
 * helpers produce that identical text once and reuse it everywhere, rather than
 * letting each agent paraphrase the description in its own words.
 */

/** Compact, prompt-ready cast sheet. Empty string when no cast is pinned. */
export function castSheet(cast: readonly Character[]): string {
  if (cast.length === 0) return "";
  return cast
    .map((c) => {
      const description = c.description.trim().replace(/\s+/g, " ");
      // Wardrobe is stated explicitly and last, so it is the most recent
      // instruction the model reads about this character. Left unstated, the
      // model invents an outfit per render and clothing changes between frames.
      const wardrobe = c.wardrobe?.trim().replace(/\s+/g, " ");
      return wardrobe
        ? `${c.name}: ${description} Wearing exactly: ${wardrobe}.`
        : `${c.name}: ${description}`;
    })
    .join(" ");
}

/**
 * Instruction appended to an agent's system prompt. Stated as a hard constraint
 * because models otherwise treat a supplied description as a suggestion and
 * drift after the first scene.
 */
export function castSystemDirective(cast: readonly Character[]): string {
  if (cast.length === 0) return "";
  const names = cast.map((c) => c.name).join(", ");
  return (
    " A fixed cast is supplied in the `cast` field of the user message: " +
    `${names}. These descriptions are locked. Reuse each character's exact ` +
    "physical description whenever that character appears, do not invent " +
    "alternative appearances, do not rename them, and do not contradict any " +
    "detail given. Where a character has a stated wardrobe, describe that exact " +
    "clothing in every prompt and never substitute or vary it. Introduce new " +
    "characters only when the story needs someone who is not in the cast."
  );
}

/**
 * Sentence appended to an image or video prompt so the render itself carries
 * the description, not just the plan.
 */
export function castPromptSuffix(cast: readonly Character[]): string {
  const sheet = castSheet(cast);
  return sheet ? ` Character continuity — ${sheet}` : "";
}

/** Character-specific traits to suppress, merged into a negative prompt. */
export function castNegativeSuffix(cast: readonly Character[]): string {
  const terms = cast
    .map((c) => c.negativePrompt?.trim())
    .filter((t): t is string => Boolean(t))
    .join(", ");
  return terms ? `, ${terms}` : "";
}
