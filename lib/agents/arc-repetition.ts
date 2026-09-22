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

import { containment, contentWords, overlap } from "@/lib/agents/text-overlap";

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

/**
 * Segments whose plan entry is its beat handed back in different words.
 *
 * Giving each window the beats it covers is what stopped the Director drifting
 * off the arc, and it made restating the easiest thing in the room: measured
 * live, every entry in the first and last windows contained no content word
 * that was not already in its beat. An intent that adds nothing is worse than a
 * missing one, because the prompt agents downstream spend attention on it and
 * get the beat they already had.
 *
 * Asymmetric by design — an entry is judged on how much of *it* is new, not on
 * how much of the beat it covers.
 */
const ECHO_THRESHOLD = 0.95;

export function echoedEntries(
  map: Record<string, string> | undefined,
  beats: readonly string[] | undefined,
): number[] {
  if (!map || !beats?.length) return [];
  const echoed: number[] = [];
  beats.forEach((beat, index) => {
    const segment = index + 1;
    const entry = map[String(segment)];
    if (!entry?.trim()) return;
    const entryWords = contentWords(entry);
    // Too short to judge: a four-word entry can be wholly contained by accident.
    if (entryWords.size < 5) return;
    if (containment(contentWords(beat), entryWords) >= ECHO_THRESHOLD) echoed.push(segment);
  });
  return echoed;
}
