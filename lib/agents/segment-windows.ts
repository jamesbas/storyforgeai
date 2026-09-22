/**
 * Writing a per-segment artifact in windows, and saying so in the prompt.
 *
 * Shared by the Story Architect, Director and Cinematographer because all three
 * failed the same way: asked for one entry per segment across a long project,
 * a local model writes about sixteen and stops. What it writes is not the first
 * sixteen segments — it is the whole story compressed into sixteen, because
 * nothing told it more entries were coming. The gap fill then asks for the
 * remainder and gets a second telling of the middle of the film.
 *
 * Observed on a 27-segment project: the Director's intent 16 was the closing
 * wide shot of an empty dance floor, intent 17 restarted the action, and the
 * beat it was supposed to be directing was the climax.
 */

/** How many segments one call may be asked for. */
export const SEGMENTS_PER_WINDOW = 8;

/** Whether this project is long enough to need splitting at all. */
export function needsWindowing(segmentCount: number | undefined): boolean {
  return segmentCount !== undefined && segmentCount > SEGMENTS_PER_WINDOW;
}

/**
 * Caps the first call and promises the rest will be asked for.
 *
 * The promise is the part that matters. A model that believes this is its only
 * chance writes a complete arc into whatever it was given, and no amount of
 * asking afterwards recovers the segments it has already spent.
 */
export function firstWindowDirective(
  segmentCount: number | undefined,
  entries: string,
): string {
  if (!needsWindowing(segmentCount)) return "";
  const remaining = segmentCount! - SEGMENTS_PER_WINDOW;
  return (
    ` This piece is ${segmentCount} segments long, which is more than one answer can hold. Write ` +
    `${entries} for segments 1 to ${SEGMENTS_PER_WINDOW} only. You will then be asked for the ` +
    "rest in order, a few at a time, with everything you have already written in front of you. " +
    `Plan the whole piece before you begin, but cover only those first ${SEGMENTS_PER_WINDOW} ` +
    `segments here — ${remaining} segments follow them, so nothing written here may resolve or ` +
    "conclude the piece."
  );
}

/**
 * Where a window sits in the whole piece.
 *
 * Without it every continuation reads as the final one, and the model lands an
 * ending in each window it is handed.
 */
export function windowPlacementDirective(
  window: readonly number[],
  segmentCount: number | undefined,
): string {
  const last = window.at(-1);
  if (segmentCount === undefined || last === undefined) return "";
  const remaining = segmentCount - last;
  return remaining > 0
    ? ` These are segments ${window[0]} to ${last} of ${segmentCount}. ${remaining} segments ` +
        "follow them, so the piece must still have somewhere to go when this window ends: do " +
        "not resolve it, wind it down, or write an ending here."
    : ` These are the final segments of the piece, so this is where it ends.`;
}

/**
 * What an entry is for, as opposed to what the beat already says.
 *
 * Handing a window its beats is what stopped the Director drifting off the arc,
 * and it made restating them the path of least resistance: measured live, every
 * entry in the first and last windows contained no content word that was not
 * already in its beat. The beats are therefore always accompanied by this,
 * including on the first call, where the beats arrive in the payload instead.
 */
export function dontRestateDirective(adds: string): string {
  return (
    " The beats are the account of what happens and your entries are not. An entry that could be " +
    `read as a description of the action is not an entry: it must add ${adds}, and it must add ` +
    "something the beat does not already say. If you find yourself reaching for the beat's own " +
    "words, you are describing the shot rather than doing your job on it."
  );
}

/**
 * The beats a window has to cover, as a numbered list in the prompt.
 *
 * The Director and Cinematographer are given the whole story plan, which is
 * right for pacing and thesis and useless for knowing which beat segment 19 is.
 * Naming the beat beside the segment number is what makes a window follow the
 * arc rather than continue whatever it last wrote.
 */
export function windowBeatsDirective(
  window: readonly number[],
  beats: readonly string[] | undefined,
): string {
  if (!beats?.length) return "";
  const lines = window
    .map((segment) => [segment, beats[segment - 1]] as const)
    .filter(([, beat]) => Boolean(beat))
    .map(([segment, beat]) => `${segment}. ${beat}`);
  if (!lines.length) return "";
  return (
    " These are the story beats for exactly those segments, and your entry for each segment must " +
    "be about that segment's beat and no other:\n" +
    lines.join("\n")
  );
}

/** The same beats as payload, so a model reading the JSON rather than the prompt still aligns. */
export function beatsForWindow(
  window: readonly number[],
  beats: readonly string[] | undefined,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const segment of window) {
    const beat = beats?.[segment - 1];
    if (beat) entries[String(segment)] = beat;
  }
  return entries;
}
