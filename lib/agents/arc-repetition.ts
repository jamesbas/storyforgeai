/**
 * Beats that say what the beat before them already said.
 *
 * A model asked to fill the end of an arc it has already resolved does not
 * refuse — it pads. Live, a 27-segment piece came back with nine closing beats
 * of aftermath and segments 26 and 27 word for word identical, each one
 * rendered as its own twenty-second clip. Nothing detected it, so the user
 * found out at the storyboard.
 *
 * A beat is defined as a change the audience can see, which is what makes this
 * checkable without a model: a beat whose words are the previous beat's words
 * describes the same moment twice, and the second one has no change in it.
 */

/**
 * Words that carry no story. Almost every beat contains "the camera", so
 * counting those makes any two beats in the same project look alike — the
 * threshold below is meaningless without this list.
 */
const IGNORED = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "back",
  "by",
  "camera",
  "for",
  "from",
  "he",
  "her",
  "here",
  "his",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "one",
  "onto",
  "out",
  "over",
  "she",
  "shot",
  "still",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "up",
  "with",
]);

function contentWords(beat: string): Set<string> {
  return new Set(
    beat
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !IGNORED.has(word)),
  );
}

/**
 * How much two beats share, 0 to 1.
 *
 * Jaccard over content words rather than anything cleverer: it needs no model,
 * it cannot be wrong about a beat it has not understood, and the failure it has
 * to catch — a beat rewritten from its neighbour with two words changed —
 * scores near 1 under it.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Deliberately high. A false positive tells the user to regenerate an arc that
 * was fine, which teaches them to ignore the warning; two consecutive beats
 * sharing three content words in four are not two beats.
 */
const REPEAT_THRESHOLD = 0.75;

/**
 * Segment numbers whose beat repeats one already written.
 *
 * Adjacent beats are compared by overlap, because that is where padding lands.
 * An exact repeat of any earlier beat counts wherever it sits: the same twenty
 * seconds cannot happen twice in one film.
 */
export function repeatedBeats(beats: readonly string[]): number[] {
  const words = beats.map(contentWords);
  const seen = new Map<string, number>();
  const repeats: number[] = [];

  beats.forEach((beat, index) => {
    const normalised = beat.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalised) return;
    const previous = index > 0 ? overlap(words[index]!, words[index - 1]!) : 0;
    if (previous >= REPEAT_THRESHOLD || seen.has(normalised)) repeats.push(index + 1);
    if (!seen.has(normalised)) seen.set(normalised, index + 1);
  });

  return repeats;
}
