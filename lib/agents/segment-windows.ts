import { planEntryFor, planningPayload, type CreativePlans } from "@/lib/agents/creative-context";

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
/** The segment numbers the first call is responsible for. */
export function firstWindow(segmentCount: number | undefined): number[] {
  const upTo = needsWindowing(segmentCount)
    ? SEGMENTS_PER_WINDOW
    : Math.max(0, segmentCount ?? 0);
  return Array.from({ length: upTo }, (_, i) => i + 1);
}

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

/**
 * Words kept from an entry outside the window: enough to place it in the
 * story, not enough to re-tell it.
 */
export const OUTLINE_WORDS = 16;

/** An entry cut to its opening words. */
export function condensed(entry: string): string {
  const words = entry.trim().split(/\s+/).filter(Boolean);
  return words.length <= OUTLINE_WORDS ? words.join(" ") : `${words.slice(0, OUTLINE_WORDS).join(" ")}…`;
}

/**
 * The whole arc as one window's request carries it: this window's beats in
 * full, every other segment as a condensed line.
 *
 * Handing every request the full arc is what made request size grow with the
 * project: on a 50-segment piece the beats alone were about 3,500 tokens, sent
 * to every Director and Cinematographer window, and LM Studio rejected the
 * Director's first request outright for exceeding its context. The outline
 * keeps the shape of the whole piece in view — where the climax is, what is
 * still to come — at a fraction of the size.
 */
export function arcOutline(
  beats: readonly string[] | undefined,
  window: readonly number[],
): Record<string, string> {
  const inWindow = new Set(window);
  const outline: Record<string, string> = {};
  (beats ?? []).forEach((beat, index) => {
    const segment = index + 1;
    if (beat?.trim()) outline[String(segment)] = inWindow.has(segment) ? beat.trim() : condensed(beat);
  });
  return outline;
}

/** A story plan with its beats replaced by the window's outline. */
export function storyPlanForWindow<T extends { segmentBeats: string[] }>(
  plan: T | undefined,
  window: readonly number[],
): (Omit<T, "segmentBeats"> & { segmentBeatsOutline: Record<string, string> }) | undefined {
  if (!plan) return undefined;
  const { segmentBeats, ...rest } = plan;
  return { ...rest, segmentBeatsOutline: arcOutline(segmentBeats, window) };
}

/**
 * The plans for an agent writing a project-level document — the art direction,
 * the visual bible — with every per-scene entry condensed to an outline line.
 *
 * Those agents need to know what happens where, not each scene's full
 * direction, and the full maps are the part of the plans that grows with the
 * project.
 */
export function planningPayloadOutline(plans: CreativePlans | undefined): CreativePlans | undefined {
  const payload = planningPayload(plans);
  if (!payload) return payload;
  const outline = (map: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(map ?? {}).map(([key, entry]) => [key, condensed(entry)]));
  return {
    ...payload,
    ...(payload.directorialPlan
      ? { directorialPlan: { ...payload.directorialPlan, sceneIntent: outline(payload.directorialPlan.sceneIntent) } }
      : {}),
    ...(payload.cinematographyPlan
      ? {
          cinematographyPlan: {
            ...payload.cinematographyPlan,
            sceneShotPlans: outline(payload.cinematographyPlan.sceneShotPlans),
          },
        }
      : {}),
  };
}

/** How many entries before a window are repeated in full for continuity. */
export const RECENT_ENTRIES = 3;

/**
 * What a continuation needs of the entries already written: the few just before
 * its window in full — the shot it must pick the camera up from, the register
 * it must not repeat — and, optionally, a condensed line for the rest.
 *
 * Sending every entry written so far grew each follow-up with the project; by
 * the last window of a 50-segment plan that was forty-two full entries the
 * window could not use.
 */
export function writtenBefore(
  map: Record<string, string>,
  window: readonly number[],
  options: { outlineEarlier?: boolean } = {},
): { alreadyWritten: Record<string, string>; earlierOutline?: Record<string, string> } {
  const first = window[0] ?? 1;
  const before: [number, string][] = [];
  for (let n = 1; n < first; n += 1) {
    const entry = planEntryFor(map, n);
    if (entry) before.push([n, entry]);
  }
  const recent = new Set(before.slice(-RECENT_ENTRIES).map(([n]) => n));
  const alreadyWritten: Record<string, string> = {};
  const earlierOutline: Record<string, string> = {};
  for (const [n, entry] of before) {
    if (recent.has(n)) alreadyWritten[String(n)] = entry;
    else if (options.outlineEarlier) earlierOutline[String(n)] = condensed(entry);
  }
  return {
    alreadyWritten,
    ...(options.outlineEarlier && Object.keys(earlierOutline).length ? { earlierOutline } : {}),
  };
}
