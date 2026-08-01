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
function appearanceFor(character: Character, forRender: boolean, faceVisible: boolean): string {
  const description = stripLeadingName(character.description, character.name);
  const facial = character.facialDescription?.trim().replace(/\s+/g, " ");
  if (!facial) return description;

  // Planning agents still see the face: they write prose, not pixels, and the
  // Visual Bible should record what the character looks like either way.
  //
  // A shot with no face in it is the other reason to withhold it: a written
  // face competes with the framing, and the model resolves the contradiction by
  // widening the shot until there is a face to show.
  const suppress = forRender && (referenceImagesOf(character).length > 0 || !faceVisible);
  return suppress ? description : `${description} ${facial}`;
}

/** Character descriptions often open with the name, which the sheet adds again. */
function stripLeadingName(description: string, name: string): string {
  const text = description.trim().replace(/\s+/g, " ");
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\s*[:\\-–—]\\s*`, "i"), "");
}

/**
 * Nudity is a wardrobe state, not an outfit.
 *
 * `Wearing exactly: nude` is a sentence a model has to reconcile, and the
 * "wearing" is the part it acts on. Stating the absence directly removes the
 * contradiction — and without a way to say it at all, the last line of a
 * prompt for an explicit scene was an instruction to put her clothes back on.
 */
const NUDE = /^(?:fully\s+|completely\s+|entirely\s+)?(?:nude|naked|undressed|bare|nothing|none|no\s+clothes|no\s+clothing)\.?$/i;

function wardrobeClause(wardrobe: string): string {
  return NUDE.test(wardrobe) ? "Fully nude, wearing nothing." : `Wearing exactly: ${wardrobe}.`;
}

/** How much of a character's sheet a shot can actually use. */
export type SheetOptions = {
  /** False when the shot crops the head, so a written face only misleads. */
  faceVisible?: boolean;
  /** True for a close-up or tighter, where a full-body inventory fights the framing. */
  tightShot?: boolean;
};

/**
 * Compact, prompt-ready cast sheet. Empty string when no cast is pinned.
 *
 * `forRender` distinguishes text destined for an image or video prompt, where a
 * reference photo may already be carrying the face, from text destined for a
 * planning agent, which has no photo and needs the full description.
 */
export function castSheet(
  cast: readonly Character[],
  forRender = false,
  wardrobeAt?: Record<string, string>,
  options: SheetOptions = {},
): string {
  if (cast.length === 0) return "";
  const faceVisible = options.faceVisible !== false;
  return cast
    .map((c) => {
      // Wardrobe is stated explicitly and last, so it is the most recent
      // instruction the model reads about this character. Left unstated, the
      // model invents an outfit per render and clothing changes between frames.
      //
      // `wardrobeAt` is this scene's point on the wardrobe timeline. Without one
      // the project constant applies, which is every project that has no
      // costume change.
      const wardrobe = (wardrobeAt?.[c.id] ?? c.wardrobe)?.trim().replace(/\s+/g, " ");
      const clause = wardrobe ? ` ${wardrobeClause(wardrobe)}` : "";

      // On a tight shot the photograph is already carrying the likeness, so a
      // head-to-toe inventory of hair, nails and jewellery describes things
      // outside the frame and crowds out the shot itself. Only when there is a
      // photograph: with text as the sole identity signal, trimming it is how
      // faces start drifting between scenes.
      if (forRender && options.tightShot && referenceImagesOf(c).length > 0) {
        return `${c.name}.${clause}`;
      }

      return `${c.name}: ${appearanceFor(c, forRender, faceVisible)}${clause}`;
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
  // Everyone in a shot needs describing; only the pinned ones have that done
  // for them. Returning nothing here once meant a scene with no pinned cast
  // lost the instruction to describe anybody, and four men at a table became
  // a pair of hands.
  const describeOthers =
    " Any person in the shot who is not in the pinned cast must be described in full in your " +
    "own prompt — age, build, hair, face and specific named garments with colours and materials " +
    "— because nothing is appended for them and an undescribed person is reinvented on every " +
    "render.";

  if (cast.length === 0) return forRender ? describeOthers : "";
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
      "clothing and never substitute or vary it — unless the story genuinely " +
      "requires a costume change, in which case narrate it plainly in that " +
      "scene's action, naming the garments removed and the garments put on, and " +
      "keep the new outfit for every scene after it. Introduce new characters " +
      "only when the story needs someone who is not in the cast."
    );
  }

  return (
    locked +
    " In the prompts you write, refer to these characters by name only. Do not " +
    "restate, paraphrase or summarise their physical appearance, wardrobe or " +
    "negative terms — the canonical text is appended to every prompt " +
    "automatically, and a second copy makes the image model render the " +
    "character twice. Name a cast character only in the prompts for shots they " +
    "actually appear in." +
    describeOthers
  );
}

/**
 * Sentence appended to an image or video prompt so the render itself carries
 * the description, not just the plan.
 *
 * Uses the render-facing cast sheet, which withholds the facial description
 * from characters that have a reference photo.
 */
export function castPromptSuffix(
  cast: readonly Character[],
  wardrobeAt?: Record<string, string>,
  options: SheetOptions = {},
): string {
  const sheet = castSheet(cast, true, wardrobeAt, options);
  return sheet ? ` Character continuity — ${sheet}` : "";
}

/**
 * The video-prompt equivalent: names and one preservation instruction.
 *
 * A clip is rendered from its start frame, which already fixes every face,
 * garment and lighting choice the sheet would describe. Repeating the sheet
 * here spends the prompt on appearance the model can already see, at the cost
 * of the motion description it cannot — both LTX and Wan warn against it — and
 * a second textual description of a subject already present in the image is how
 * a clip ends up rendering that subject twice.
 */
export function castContinuityClause(
  cast: readonly Character[],
  wardrobeChange = "",
): string {
  if (cast.length === 0) return "";
  const names = cast.map((c) => c.name).join(", ");
  // A scene that depicts a costume change must not also be told to hold the
  // wardrobe still; the two instructions cannot both be obeyed.
  if (wardrobeChange) {
    return (
      ` The start frame fixes how ${names} look. Keep face, hair and lighting unchanged.` +
      wardrobeChange
    );
  }
  return (
    ` The start frame fixes how ${names} look. Keep face, hair, wardrobe and lighting ` +
    "unchanged throughout."
  );
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
