import { referenceImagesOf } from "@/lib/schemas/character";
import type { Character } from "@/lib/schemas/character";

/**
 * Turns library characters into prompt fragments.
 *
 * Character consistency across independently generated clips is the hardest
 * part of this pipeline: each scene is a separate render, so the only thing
 * holding a face together is that every prompt describes it identically. These
 * helpers produce that identical text once and reuse it everywhere, rather than
 * letting each agent paraphrase the description in its own words.
 *
 * That reasoning holds only while text is the *sole* identity signal. Once a
 * reference photo is supplied the two compete, and under classifier-free
 * guidance the text wins — a written face overrides a photographed one, which is
 * exactly backwards. So `facialDescription` is withheld from render prompts when
 * a photo exists, while everything a headshot cannot convey keeps its place.
 */

/** The description text a render prompt should carry for one character. */
function appearanceFor(character: Character, forRender: boolean): string {
  const description = character.description.trim().replace(/\s+/g, " ");
  const facial = character.facialDescription?.trim().replace(/\s+/g, " ");
  if (!facial) return description;

  // Planning agents still see the face: they write prose, not pixels, and the
  // Visual Bible should record what the character looks like either way.
  const suppress = forRender && referenceImagesOf(character).length > 0;
  return suppress ? description : `${description} ${facial}`;
}

/**
 * Compact, prompt-ready cast sheet. Empty string when no cast is pinned.
 *
 * `forRender` distinguishes text destined for an image or video prompt, where a
 * reference photo may already be carrying the face, from text destined for a
 * planning agent, which has no photo and needs the full description.
 */
export function castSheet(cast: readonly Character[], forRender = false): string {
  if (cast.length === 0) return "";
  return cast
    .map((c) => {
      const description = appearanceFor(c, forRender);
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
 *
 * `forRender` flips what the agent is asked to do with the description, and the
 * two cases genuinely differ. A planning agent — the Visual Bible, the
 * Storyboard Artist — is writing the document that records what a character
 * looks like, so it must carry the description. A prompt agent is not:
 * `castPromptSuffix` already appends the canonical sheet to every render prompt
 * verbatim, so an agent that also writes the appearance into its own sentence
 * ships two descriptions of one person in a single prompt. Image models read
 * that as two people, which is how a shot of one character comes back with a
 * duplicate or a fused, deformed subject.
 */
export function castSystemDirective(cast: readonly Character[], forRender = false): string {
  if (cast.length === 0) return "";
  const names = cast.map((c) => c.name).join(", ");
  const locked =
    " A fixed cast is supplied in the `cast` field of the user message: " +
    `${names}. These descriptions are locked: never invent an alternative ` +
    "appearance, never rename them, and never contradict a detail given.";

  if (!forRender) {
    return (
      locked +
      " Reuse each character's exact physical description whenever that character " +
      "appears. Where a character has a stated wardrobe, describe that exact " +
      "clothing and never substitute or vary it. Introduce new characters only " +
      "when the story needs someone who is not in the cast."
    );
  }

  return (
    locked +
    " In the prompts you write, refer to these characters by name only. Do not " +
    "restate, paraphrase or summarise their physical appearance, wardrobe or " +
    "negative terms — the canonical text is appended to every prompt " +
    "automatically, and a second copy makes the image model render the " +
    "character twice. Name a cast character only in the prompts for shots they " +
    "actually appear in. Introduce new characters only when the story needs " +
    "someone who is not in the cast; describe those in full, since nothing is " +
    "appended for them."
  );
}

/**
 * Sentence appended to an image or video prompt so the render itself carries
 * the description, not just the plan.
 *
 * Uses the render-facing cast sheet, which withholds the facial description
 * from characters that have a reference photo.
 */
export function castPromptSuffix(cast: readonly Character[]): string {
  const sheet = castSheet(cast, true);
  return sheet ? ` Character continuity — ${sheet}` : "";
}

/**
 * Character-specific traits to suppress, merged into a negative prompt.
 *
 * `existing` is the negative prompt the terms are about to be appended to.
 * Terms already in it are dropped: two cast members can share a suppression, and
 * a model that echoed the list despite being told not to would otherwise have it
 * repeated back. A negative prompt is a weighted list, so a duplicated term is
 * not merely untidy — it doubles that term's pull on the render.
 */
export function castNegativeSuffix(cast: readonly Character[], existing = ""): string {
  const present = existing.toLowerCase();
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const character of cast) {
    for (const raw of (character.negativePrompt ?? "").split(",")) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key) || present.includes(key)) continue;
      seen.add(key);
      terms.push(term);
    }
  }

  return terms.length ? `, ${terms.join(", ")}` : "";
}
