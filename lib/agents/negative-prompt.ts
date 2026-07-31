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
 * Exclusions rewritten as the thing to render instead.
 *
 * BFL's guidance is not merely that FLUX ignores negatives but that the fix is
 * to name the desired alternative, because "no blur" gives the model nothing to
 * construct while "crisp subject detail" does. Terms with no known alternative
 * fall through to a closing absence clause, which is the form BFL's own
 * examples use for text.
 */
const POSITIVE_ALTERNATIVES: ReadonlyArray<readonly [RegExp, string]> = [
  [/watermark|signature|logo/, "clean unmarked surfaces"],
  [/distorted anatomy|deformed|mutated|malformed/, "correct natural anatomy"],
  [/extra limbs?|duplicated? (subjects?|limbs?)|duplicate/, "a single correctly formed subject"],
  [/warped hands?|bad hands?|extra fingers?/, "hands in a relaxed natural pose with five fingers"],
  [/text artifacts?|lettering|typography|caption/, "no signs, labels or lettering anywhere"],
  [/low quality|lowres|low resolution|jpeg artifacts?/, "sharp, cleanly resolved detail"],
  [/blur(ry|red)?/, "crisp subject detail"],
  [/oversaturat(ed|ion)|garish/, "a restrained natural colour palette"],
  [/clutter(ed)?|busy background/, "a sparse, uncluttered setting"],
  [/waxy skin|plastic skin|over-?smoothed/, "natural skin texture with visible pores"],
  [/dramatic shadows?|harsh shadows?/, "evenly diffused soft illumination"],
];

/**
 * Turn a negative prompt into a clause for models that cannot use one.
 *
 * Returns an empty string when there is nothing to say, so callers can append
 * it unconditionally.
 */
export function positiveConstraintClause(raw: string): string {
  const alternatives: string[] = [];
  const absent: string[] = [];
  const seen = new Set<string>();

  for (const term of negativeTerms(raw)) {
    const match = POSITIVE_ALTERNATIVES.find(([pattern]) => pattern.test(term.toLocaleLowerCase()));
    const rendered = match?.[1] ?? null;
    if (rendered) {
      if (seen.has(rendered)) continue;
      seen.add(rendered);
      alternatives.push(rendered);
    } else {
      absent.push(term);
    }
  }

  const parts: string[] = [];
  if (alternatives.length) parts.push(` Render with ${joinList(alternatives)}.`);
  if (absent.length) parts.push(` The frame is free of ${joinList(absent)}.`);
  return parts.join("");
}

function joinList(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
