import { referenceImagesOf } from "@/lib/schemas/character";
import { positiveGarments } from "@/lib/agents/wardrobe";
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

/**
 * How much description the whole cast may contribute to one render prompt.
 *
 * A model divides its attention roughly by how much is written about each
 * person. One character's stored description ran to 966 characters against 183
 * for the man the shot was actually about, and the render obliged: it drew the
 * character it had been told most about twice and left the other out. The same
 * scene, cut to a compact description per person, came back correct first time.
 *
 * The budget is for the sheet rather than per character, because a per-person
 * allowance grows with the cast: at 220 each, a six-hander is back to the 1500
 * characters that failed. Sharing a fixed total means a crowd gets terse
 * descriptions and a two-hander gets generous ones, and the prompt as a whole
 * stays the size that works.
 *
 * Render prompts only. A planning agent is writing the document that records
 * what someone looks like and needs all of it.
 */
const RENDER_SHEET_BUDGET = 620;
/** Generous enough for one or two people without letting either run away. */
const RENDER_APPEARANCE_CEILING = 240;
/** Below this a description identifies nobody, so a crowd is trimmed no further. */
const RENDER_APPEARANCE_FLOOR = 110;

/** The share of the sheet budget each character in this shot may spend. */
function appearanceBudgetFor(castSize: number): number {
  if (castSize <= 0) return RENDER_APPEARANCE_CEILING;
  const share = Math.floor(RENDER_SHEET_BUDGET / castSize);
  return Math.min(RENDER_APPEARANCE_CEILING, Math.max(RENDER_APPEARANCE_FLOOR, share));
}

/** Trim to a budget on a sentence boundary where possible, a word boundary otherwise. */
function compactForRender(text: string, budget: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= budget) return clean;

  const window = clean.slice(0, budget + 1);
  const sentence = window.lastIndexOf(". ");
  if (sentence > budget / 2) return clean.slice(0, sentence + 1);
  const word = window.lastIndexOf(" ");
  return clean.slice(0, word > 0 ? word : budget);
}

/**
 * Attach the wardrobe to the person rather than stating it afterwards.
 *
 * `Wearing exactly: <outfit>` as its own sentence is an attribute with nothing
 * to anchor it: on a three-person prompt the outfit landed on whichever body
 * could wear it, putting a husband's polo shirt and jeans on a man who was
 * supposed to be naked. Inside the same clause as the description it belongs
 * to, it stays with him.
 */
function boundAppearance(appearance: string, wardrobe: string | undefined): string {
  const body = appearance.trim().replace(/[.,;\s]+$/, "");
  if (!wardrobe) return `${body}.`;
  // "dressed in" rather than "wearing": a description trimmed to a sentence
  // boundary often already ends on one of the character's own garments, and
  // "she wears small gold hoop earrings, wearing a bra" reads as two outfits.
  return NUDE.test(wardrobe)
    ? `${body}, completely naked with no clothing.`
    : `${body}, dressed in ${positiveGarments(wardrobe)}.`;
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
  const budget = appearanceBudgetFor(cast.length);
  return cast
    .map((c) => {
      // Wardrobe is stated with the person rather than after them: an outfit on
      // its own is an attribute the model attaches to whichever body suits it.
      //
      // `wardrobeAt` is this scene's point on the wardrobe timeline. Without one
      // the project constant applies, which is every project that has no
      // costume change.
      const wardrobe = (wardrobeAt?.[c.id] ?? c.wardrobe)?.trim().replace(/\s+/g, " ");

      // On a tight shot the photograph is already carrying the likeness, so a
      // head-to-toe inventory of hair, nails and jewellery describes things
      // outside the frame and crowds out the shot itself. Only when there is a
      // photograph: with text as the sole identity signal, trimming it is how
      // faces start drifting between scenes.
      if (forRender && options.tightShot && referenceImagesOf(c).length > 0) {
        return wardrobe ? `${c.name}: ${wardrobeClause(wardrobe)}` : `${c.name}.`;
      }

      const appearance = appearanceFor(c, forRender, faceVisible);
      if (!forRender) {
        const clause = wardrobe ? ` ${wardrobeClause(wardrobe)}` : "";
        return `${c.name}: ${appearance}${clause}`;
      }
      return `${c.name}: ${boundAppearance(compactForRender(appearance, budget), wardrobe)}`;
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
 * looks like, so it carries the description as reference prose. A prompt agent
 * is writing for an image model, which needs the description bound to the body
 * it belongs to.
 *
 * Render agents were once told the opposite — name the character and never
 * describe them, because `castPromptSuffix` appends the canonical sheet. The
 * reasoning was that two descriptions render two people, which is true; the
 * error was not seeing that the appended sheet is itself the second mention. A
 * text encoder has never heard of "Mara", so a name in one sentence and an
 * appearance in another do not corefer — they are two subjects. A live scene
 * placing a sleeping woman in prose and describing her in the appended sheet
 * rendered both: a generic woman in the bed and a second, on-model one sitting
 * in the foreground.
 */
export function castSystemDirective(cast: readonly Character[], forRender = false): string {
  // Everyone in a shot needs describing; only the pinned ones have that done
  // for them. Returning nothing here once meant a scene with no pinned cast
  // lost the instruction to describe anybody, and four men at a table became
  // a pair of hands.
  const describeOthers =
    " Any person in the shot who is not in the pinned cast must be described in your own " +
    "prompt, because nothing is appended for them: age, build, hair, skin and specific named " +
    "garments with colours, in one compact clause of roughly twenty-five words rather than a " +
    "paragraph. An undescribed person is reinvented on every render, or dressed in whatever " +
    "clothing a carried-over reference frame happens to show, which is how a new character " +
    "arrives wearing another character's outfit. Length is not safety: a model divides its " +
    "attention by how much is written about each person, so describing one at four times the " +
    "length of another renders that one twice and drops the other. Keep every person in a shot " +
    "described to roughly the same length, and state each one's clothing in the same clause as " +
    "the person, never as a separate sentence afterwards. " +
    // Two men written as "a heavy-set black man in his 40s" and "the second
    // heavy-set black man" gave the model nothing to tell them apart, and a
    // three-person frame came back with four people in it.
    "Where two people in a shot would otherwise read the same, give each of them one detail " +
    "that separates them \u2014 a beard, a shaved head, a tattoo, a scar, a different hairline. Two " +
    "people described identically are one description to a model, which renders it twice and " +
    "then has no idea how many people you asked for.";

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
      "appears. A stated wardrobe is what that character is wearing until the story " +
      "changes it: describe that exact clothing, and never substitute or vary it for " +
      "effect. A costume change belongs to the one scene where it happens, states the " +
      "complete resulting outfit, and holds for every scene after it. Introduce new " +
      "characters only when the story needs someone who is not in the cast."
    );
  }

  return (
    locked +
    " In the prompts you write, describe each of these characters inline, in the " +
    "same clause as the words that place them in the shot: age, build, hair, skin " +
    "and their specific named garments with colours, in roughly twenty-five words. " +
    "Use the supplied description and invent nothing it does not give. Attach the " +
    "description to the name as a phrase inside the sentence that places them, " +
    "never as a sentence of its own: write 'Mara, a 52-year-old woman with " +
    "honey-blonde wavy hair in cream silk pyjamas, lies asleep under the blankets', " +
    "and never 'Mara lies asleep under the blankets. Mara is a 52-year-old " +
    "woman with honey-blonde wavy hair.' The second shape names the character " +
    "twice, and an image model has never heard of her, so the two mentions are two " +
    "separate people to it and it draws both. Mention each character exactly once. " +
    "Do not add a separate list of names and attributes afterwards. Name a cast " +
    "character only in the prompts for shots they actually appear in." +
    describeOthers
  );
}

/** Words that carry no identity, so a body repeating them proves nothing. */
const GENERIC_APPEARANCE =
  /^(?:with|and|the|her|his|their|she|he|they|wears|wearing|dressed|year|years|old|tall|about|around|beautiful|attractive|woman|women|man|men|person|people)$/i;

function identityWords(text: string): string[] {
  const words = text.toLocaleLowerCase().match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words)].filter((word) => !GENERIC_APPEARANCE.test(word));
}

/**
 * Whether a prompt body already carries a character's appearance.
 *
 * The sheet is a fallback now rather than the primary channel, so it is
 * appended only where the agent did not follow the instruction to describe the
 * character inline. Losing the description entirely is the worse failure, so
 * the bar is deliberately low: a quarter of the distinguishing words is enough
 * to conclude the body is describing this person rather than merely naming
 * them.
 *
 * Measured against the text the sheet would actually print, which is why
 * `castSize` is needed — `castSheet` compacts a description to a per-character
 * budget, and a live record ran to a hundred and fifty words of build, skin,
 * nails and jewellery that the sheet truncates away. Compared against the full
 * record, a prompt reproducing every word the sheet would have emitted still
 * scored below the bar and got the sheet appended anyway.
 *
 * Reads the canonical appearance, not the wardrobe, because a character's
 * clothing changes between scenes and their face does not.
 */
export function describedInline(body: string, character: Character, castSize = 1): boolean {
  const appearance = appearanceFor(character, true, true);
  const words = identityWords(compactForRender(appearance, appearanceBudgetFor(castSize)));
  if (words.length < 4) return false;
  const lower = body.toLocaleLowerCase();
  return words.filter((word) => lower.includes(word)).length / words.length >= 0.25;
}

/**
 * Sentence appended to an image or video prompt so the render itself carries
 * the description, not just the plan.
 *
 * Uses the render-facing cast sheet, which withholds the facial description
 * from characters that have a reference photo.
 *
 * `body` is the prompt this will be appended to. A character it already
 * describes is skipped: appending the sheet as well is the second mention that
 * makes the model draw them twice.
 */
export function castPromptSuffix(
  cast: readonly Character[],
  wardrobeAt?: Record<string, string>,
  options: SheetOptions = {},
  body?: string,
): string {
  const missing = body ? cast.filter((c) => !describedInline(body, c, cast.length)) : cast;
  const sheet = castSheet(missing, true, wardrobeAt, options);
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
