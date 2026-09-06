import { computeSegmentation } from "@/lib/duration";

/**
 * Whether the runtime a project asked for can hold the story it described.
 *
 * Scene length is fixed: every scene is exactly `segmentSeconds` long, and the
 * scene count is the runtime divided by it. Nothing downstream can create room
 * — so a brief describing more distinct actions than there are segments is
 * compressed, and the compression lands wherever the model happens to yield.
 * That is the mechanism behind both halves of the usual complaint: the middle
 * is rushed, and the beats that survive intact are the cheap ones at the end.
 *
 * Checked here, deterministically and before a single model call, because the
 * only cheap fix is the one the user can still make: ask for longer.
 */

/**
 * Splits a brief into the actions it describes.
 *
 * Sentence terminators first, then the connectives that mark one action ending
 * and the next beginning. "and" alone is deliberately absent — it joins
 * adjectives and objects far more often than it joins events, and counting it
 * turned every descriptive sentence into three beats.
 */
const BEAT_SEPARATORS =
  /[.!?;]+|\b(?:and then|but then|then|after (?:that|which)|afterwards|next|later|meanwhile|finally|eventually|before long|once (?:he|she|they|it)|until)\b/gi;

/**
 * A fragment has to name somebody and something they do to count as an action.
 *
 * Two words, not three: "she runs" is a beat, and a higher floor discarded the
 * short declarative sentences that briefs are often written in.
 */
const MIN_BEAT_WORDS = 2;

/**
 * How many distinct actions a brief describes.
 *
 * An estimate, and deliberately a conservative one: it counts what the writer
 * actually separated rather than trying to infer implied action, so it
 * under-reports far more often than it over-reports. That asymmetry is the
 * right one — a warning that fires on a brief which would have fitted is worse
 * than staying quiet, because it teaches people to ignore it.
 */
export function countImpliedBeats(concept: string): number {
  const fragments = concept
    .split(BEAT_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= MIN_BEAT_WORDS);
  return fragments.length;
}

export type BeatBudget = {
  /** Distinct actions the brief describes. */
  impliedBeats: number;
  /** Scenes the requested runtime provides. */
  availableScenes: number;
  /** The runtime that would give every action a scene of its own. */
  suggestedDurationSeconds: number;
};

/**
 * Report that a brief describes more than its runtime can hold, or null.
 *
 * Null covers both "it fits" and "there is not enough here to judge": a
 * one-line concept implies one beat and says nothing about how long the film
 * should be, so the check has no opinion on it.
 */
export function beatBudget(args: {
  concept: string;
  requestedDurationSeconds: number;
  segmentSeconds: number;
}): BeatBudget | null {
  const { concept, requestedDurationSeconds, segmentSeconds } = args;
  if (!concept.trim() || requestedDurationSeconds <= 0 || segmentSeconds <= 0) return null;

  const impliedBeats = countImpliedBeats(concept);
  const { segmentCount } = computeSegmentation(requestedDurationSeconds, segmentSeconds);
  if (impliedBeats <= segmentCount) return null;

  return {
    impliedBeats,
    availableScenes: segmentCount,
    suggestedDurationSeconds: impliedBeats * segmentSeconds,
  };
}

/**
 * How many of the closing scenes may be aftermath rather than story.
 *
 * Left to itself the arc instruction produces a long tail: the model treats
 * "resolve" as a phase to fill rather than a landing, and spends scenes on
 * reaction shots and empty rooms while the middle it just compressed needed
 * them. One closing scene is enough below ten; a long piece can afford two.
 */
export function denouementBudget(segmentCount: number): number {
  if (segmentCount <= 3) return 1;
  return segmentCount >= 10 ? 2 : 1;
}
