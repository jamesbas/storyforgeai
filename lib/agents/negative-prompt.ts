/**
 * Negative prompts are a weighted term list, not a sentence.
 *
 * Every negative prompt in this project was written as prose negation — "no
 * watermarks, no distorted anatomy" — which is how a person states an
 * exclusion and not how a sampler reads one. The text encoder has no operator
 * for "no": the phrase is embedded whole and the render is steered away from
 * it, so the negation contributes nothing while its noun does the work by
 * accident. Stripping the negation costs nothing and removes the ambiguity.
 */

/** Leading negations to strip, longest first so "no more" loses both words. */
const NEGATIONS = [
  "without any",
  "without",
  "avoid any",
  "avoid",
  "not a",
  "not an",
  "not",
  "no more",
  "no",
];

function stripNegation(term: string): string {
  const lower = term.toLocaleLowerCase();
  for (const negation of NEGATIONS) {
    if (lower === negation) return "";
    if (lower.startsWith(`${negation} `)) return term.slice(negation.length + 1).trim();
  }
  return term;
}

/**
 * Split a negative prompt into clean, de-duplicated terms.
 *
 * De-duplication is not tidiness: a term repeated twice pulls twice as hard on
 * the render, and terms arrive here from several appenders that cannot see each
 * other's output.
 */
export function negativeTerms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of raw.split(",")) {
    const term = stripNegation(part.trim().replace(/\.+$/, ""));
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/** A negative prompt reduced to the term list a sampler actually wants. */
export function normaliseNegative(raw: string): string {
  return negativeTerms(raw).join(", ");
}

/**
 * Drop exclusions the agents wrote against one character by name.
 *
 * The prompt agents produce terms like `dark skin for Jaime` and `black hair on
 * Mara`, which read as careful per-person direction and are nothing of the
 * sort. A negative prompt is a bag of embeddings with no addressee: the sampler
 * sees `dark skin` and steers the whole frame away from it. In a shot whose
 * leading man is black, an exclusion meant to protect one character's skin tone
 * was suppressing another's — and the render kept returning a man who was too
 * light, or replacing him altogether.
 *
 * Both prepositions, because the agents use both and a rule that caught only
 * one left the other working unchecked in half the projects on disk. Matching
 * is anchored to a cast name, so an ordinary term that happens to contain "on"
 * is untouched.
 *
 * Where the frame holds one person the scope is redundant rather than wrong, so
 * the trait is kept and the name dropped. Anywhere else, and anywhere the
 * population is unstated, the term goes: an exclusion that cannot be aimed is a
 * liability, and the positive prompt already says what each person looks like.
 */
export function withoutCharacterScopedTerms(
  raw: string,
  castNames: readonly string[],
  headcount: number | null,
): string {
  const names = castNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return normaliseNegative(raw);

  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const scoped = new RegExp(`\\s+(?:for|on|to)\\s+(?:${escaped.join("|")})\\s*$`, "i");

  return negativeTerms(raw)
    .flatMap((term) => {
      if (!scoped.test(term)) return [term];
      return headcount === 1 ? [term.replace(scoped, "").trim()] : [];
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * Drop a character's stored exclusions from a frame holding other people.
 *
 * The library's `negativePrompt` is written about one person — "not
 * overweight", to keep one woman slim — and a negative prompt has no
 * addressee, so in a three-hander it steers every body in the frame. A live
 * project described two men as heavy-set in the positive prompt and sent
 * "heavy-set" as an exclusion in the same job; between that list and the world
 * bible's own "athletic physique, flat stomach", the render was forbidden every
 * build there is.
 *
 * Kept where the frame holds exactly one person: there the scope is redundant
 * rather than wrong, which is the rule `withoutCharacterScopedTerms` already
 * applies to the agents' own scoped terms.
 */
export function withoutCharacterNegatives(
  raw: string,
  cast: readonly { negativePrompt?: string }[],
  headcount: number | null,
): string {
  if (headcount === 1) return normaliseNegative(raw);
  const scoped = new Set(
    cast
      .flatMap((character) => negativeTerms(character.negativePrompt ?? ""))
      .map((term) => term.toLocaleLowerCase()),
  );
  if (scoped.size === 0) return normaliseNegative(raw);
  return negativeTerms(raw)
    .filter((term) => !scoped.has(term.toLocaleLowerCase()))
    .join(", ");
}

/**
 * Drop exclusions the positive prompt is asking for.
 *
 * A term in both halves of one job is not an emphasis, it is a contradiction,
 * and the sampler settles it by averaging: a prompt describing a heavy-set man
 * while excluding "heavy-set" returns neither a heavy man nor a lean one. The
 * positive prompt wins, because it is the thing somebody wrote the scene to
 * show.
 *
 * Word-boundary matched, so an exclusion is only dropped when the prompt really
 * does ask for that term rather than merely containing its letters — but with up
 * to two words allowed between the term's own. A prompt describing two men
 * "with short cropped hair" was excluding "short hair" in the same job, because
 * an exact phrase match cannot see the adjective sitting in the middle. The
 * render was pulled both ways on the only feature distinguishing them.
 */
export function withoutContradictions(raw: string, prompt: string): string {
  return negativeTerms(raw).filter((term) => !promptAsksFor(term, prompt)).join(", ");
}

function promptAsksFor(term: string, prompt: string): boolean {
  const words = term
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return false;
  return new RegExp(`\\b${words.join("\\W+(?:\\w+\\W+){0,2}")}\\b`, "i").test(prompt);
}

/**
 * Guards for a shot holding more than one body.
 *
 * Two failures, both specific to a crowded frame and neither of them something
 * the prompt agents write about. They produce exclusions about build and
 * lighting: a two-person intimate frame went out with twenty-two terms, every
 * one of them about a waistline or a colour temperature, and nothing at all
 * about population or limbs.
 *
 * The first is duplication — asked for three people, the model drew the
 * character it had been told most about twice and omitted another. The second
 * is anatomy: entangled bodies are where limbs multiply, and an intimate
 * two-shot came back with a spare leg and a second torso.
 *
 * Only where the prompt states two or more people. On a single figure these
 * have far less to catch, and a negative term with no work to do still pulls on
 * the render.
 */
const MULTI_SUBJECT_TERMS = [
  "duplicated person",
  "the same face twice",
  "cloned face",
  "twins",
  "extra limbs",
  "extra arms",
  "extra legs",
  "fused bodies",
  "malformed anatomy",
] as const;

const MULTI_SUBJECT_SET: ReadonlySet<string> = new Set(MULTI_SUBJECT_TERMS);

export function withMultiSubjectGuards(raw: string, headcount: number | null): string {
  if (headcount === null || headcount < 2) return normaliseNegative(raw);
  return normaliseNegative(`${raw}, ${MULTI_SUBJECT_TERMS.join(", ")}`);
}

/**
 * Guards for a frame that depicts an act rather than a pose.
 *
 * Entangled bodies are the hardest thing an image model is ever asked for, and
 * the way it fails is specific: handed anatomy it cannot resolve — a cock
 * entering a mouth, drawn from the side, with a second man's body in the way —
 * it substitutes a shape it can draw. A live render returned a spoon-like
 * object at the woman's mouth where the second man's cock should have been.
 * That is not distortion, which `malformed anatomy` already covers; it is the
 * model reaching for a familiar prop, and nothing in the list was asking it not
 * to.
 *
 * The other three are the same class of substitution: a limb that belongs to
 * nobody, genitals hidden behind an arm the model put there to avoid drawing
 * them, and the censoring a model trained on moderated data adds by itself.
 *
 * Kept off any frame that is not depicting an act. A negative term with no work
 * to do still pulls on the render, and on a clothed scene every one of these
 * would be pulling against nothing.
 */
const ACT_TERMS = [
  "stray objects",
  "detached body parts",
  "misplaced anatomy",
  "obscured genitals",
  "censorship bars",
] as const;

export function withActGuards(raw: string, depictsAct: boolean): string {
  if (!depictsAct) return normaliseNegative(raw);
  return normaliseNegative(`${raw}, ${ACT_TERMS.join(", ")}`);
}

/** Words too general to be worth suppressing on their own. */
const WEAK_TRAIT = /^(?:a|an|the|and|or|of|at|all|any|one|more|other|else|longer|visible)$/i;

/**
 * A capture that turned out to be a clause rather than a thing.
 *
 * "No one is cropped at or above the neck" is a sentence about the framing, not
 * a trait, and harvesting it produced the exclusion `is cropped` — which then
 * folded back into the positive prompt on Krea as "the frame is free of … is
 * cropped and is left as". Two fragments of English, in the highest-weight
 * exclusion clause, in every prompt that carried a framing note.
 */
const CLAUSE_FRAGMENT =
  /\b(?:is|are|was|were|be|been|being|has|have|had|will|would|can|could|do|does|did)\b/i;

/**
 * Traits a positive prompt asked for by stating their absence.
 *
 * A description reading "no sharp angular edges" or "without a nose or mouth"
 * embeds `sharp angular edges` and `nose or mouth`, and the model draws them —
 * a robot described as having no mouth came back with a working one, which
 * invalidated a whole prompt-format experiment before anyone noticed why.
 *
 * The positive text is left exactly as written: rewriting an agent's sentence
 * risks changing what it meant, and the fix does not need to. Naming the same
 * traits in the negative prompt puts them where a sampler can actually act on
 * them, and the two together resolve the way the author intended.
 */
export function negatedTraitsIn(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(/\b(?:no|without)\s+((?:[a-z-]+\s+){0,3}[a-z-]+)\b/gi)) {
    // "no nose or mouth" is two traits; one run-on term suppresses neither well.
    for (const part of match[1]!.split(/\s+(?:or|and)\s+/i)) {
      if (CLAUSE_FRAGMENT.test(part)) continue;
      const phrase = part
        .split(/\s+/)
        .filter((word) => !WEAK_TRAIT.test(word))
        .join(" ")
        .trim();
      if (phrase.length >= 3) found.add(phrase.toLocaleLowerCase());
    }
  }
  return [...found];
}

/** A negative prompt that also suppresses whatever the positive asked to be absent. */
export function withNegatedTraits(negative: string, prompt: string): string {
  const traits = negatedTraitsIn(prompt);
  return traits.length ? normaliseNegative(`${negative}, ${traits.join(", ")}`) : normaliseNegative(negative);
}

/**
 * Exclusions rewritten as the thing to render instead.
 *
 * BFL's guidance is not merely that FLUX ignores negatives but that the fix is
 * to name the desired alternative, because "no blur" gives the model nothing to
 * construct while "crisp subject detail" does. Terms with no known alternative
 * fall through to a closing absence clause, which is the form BFL's own
 * examples use for text.
 */
const SINGLE_SUBJECT = "a single correctly formed subject";

const POSITIVE_ALTERNATIVES: ReadonlyArray<readonly [RegExp, string]> = [
  [/watermark|signature|logo/, "clean unmarked surfaces"],
  [/distorted anatomy|deformed|mutated|malformed/, "correct natural anatomy"],
  [/stray objects?|misplaced objects?|props/, "only bare skin and flesh at every point of contact"],
  [/detached body parts?|floating limbs?/, "every limb joined to the body it belongs to"],
  // Distinct from a detached limb: the part is attached, to the wrong person or
  // the wrong place. A live render put a man's penis at his own mouth, which
  // "every limb joined to the body it belongs to" does not describe or forbid.
  [
    /misplaced anatomy|misattached|wrong place/,
    "every part of each body where it anatomically belongs — genitals at the groin, mouths on faces",
  ],
  [
    /obscured genitals|censorship bars?|pixelat(?:ed|ion)|mosaic/,
    "genitals and the point of contact fully visible and unobstructed",
  ],
  [/extra limbs?|duplicated? (subjects?|limbs?)|duplicate/, SINGLE_SUBJECT],
  [/warped hands?|bad hands?|extra fingers?/, "hands in a relaxed natural pose with five fingers"],
  [/text artifacts?|lettering|typography|caption/, "no signs, labels or lettering anywhere"],
  [/low quality|lowres|low resolution|jpeg artifacts?/, "sharp, cleanly resolved detail"],
  [/blur(ry|red)?/, "crisp subject detail"],
  [/oversaturat(ed|ion)|garish/, "a restrained natural colour palette"],
  [/clutter(ed)?|busy background/, "a sparse, uncluttered setting"],
  [/waxy skin|plastic skin|over-?smoothed/, "natural skin texture with visible pores"],
  [/dramatic shadows?|harsh shadows?/, "evenly diffused soft illumination"],
];

const COUNT_WORDS = ["", "one", "two", "three", "four", "five"] as const;

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/**
 * Turn a negative prompt into a clause for models that cannot use one.
 *
 * `headcount` is the population the positive prompt states, and it changes the
 * answer twice over. The multi-subject guards are the clearest case a fold can
 * do harm: `withMultiSubjectGuards` adds `twins` and `the same face twice` to
 * protect a crowded frame, and on a model that discards negatives those terms
 * came back out as "the frame is free of the same face twice, cloned face,
 * twins" — naming duplication in a positive prompt, which is the failure
 * `negatedTraitsIn` above exists to document. A live Krea render of a
 * three-hander returned the same woman twice and neither of the two men.
 *
 * Worse, `extra limbs` and `duplicated person` both map to "a single correctly
 * formed subject", an alternative written for a portrait and flatly wrong in a
 * shot that asked for three people. So a guard is never spelled out as an
 * absence, and where the frame is crowded the ones about population collapse
 * into the single thing a sampler can construct: a stated count of distinct
 * people. Guards that still map cleanly — `malformed anatomy` is about a body,
 * not a headcount — keep their alternative.
 *
 * **Nothing else is spelled out as an absence either, as of 1.98.** The rule
 * v1.86 applied to the duplication guards was always general: a model that
 * cannot process negation reads "the frame is free of X" as X. It was left as a
 * fallback for every unmapped term, and that fallback did exactly what the rule
 * predicts. A three-hander whose exclusions carried `Athletic physique`,
 * `Toned abdominal muscles`, `Lean muscle definition` and `Muscular arms` — all
 * written to protect one woman's build — folded into a sentence naming four
 * muscle attributes, and the two men the prompt describes once as "heavy-set"
 * came back muscular in every render that carried the clause and heavy-set in
 * the one that did not. Four late, specific mentions beat one early word.
 *
 * A term with no alternative is therefore dropped. That loses the author's
 * intent, which is a real cost — but naming the thing you are trying to avoid,
 * to a model that will draw it, is not intent, it is the opposite outcome. The
 * count is logged so the loss is visible rather than silent. Exclusions still
 * reach every model that acts on a negative prompt untouched; this is only
 * about the ones that discard it.
 *
 * Returns an empty string when there is nothing to say, so callers can append
 * it unconditionally.
 */
export function positiveConstraintClause(raw: string, headcount: number | null = null): string {
  const crowded = headcount !== null && headcount >= 2;
  const alternatives: string[] = [];
  const seen = new Set<string>();
  let guarded = false;

  for (const term of negativeTerms(raw)) {
    const lower = term.toLocaleLowerCase();
    const guard = MULTI_SUBJECT_SET.has(lower);
    const match = POSITIVE_ALTERNATIVES.find(([pattern]) => pattern.test(lower));
    const rendered = match?.[1] ?? null;
    if (rendered === SINGLE_SUBJECT && crowded) {
      guarded = true;
      continue;
    }
    if (rendered) {
      if (seen.has(rendered)) continue;
      seen.add(rendered);
      alternatives.push(rendered);
    } else if (guard) {
      guarded = true;
    }
  }

  if (guarded && crowded) {
    alternatives.unshift(`exactly ${countWord(headcount!)} distinct people, each with their own face and body`);
  }

  return alternatives.length ? ` Render with ${joinList(alternatives)}.` : "";
}

/**
 * Exclusions a folded prompt has to drop, because there is nothing to render
 * instead and naming them would summon them.
 */
export function unfoldableTerms(raw: string): string[] {
  return negativeTerms(raw).filter((term) => {
    const lower = term.toLocaleLowerCase();
    if (MULTI_SUBJECT_SET.has(lower)) return false;
    return !POSITIVE_ALTERNATIVES.some(([pattern]) => pattern.test(lower));
  });
}

function joinList(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
