/**
 * How much two pieces of writing share, without a model.
 *
 * Used to catch two different failures that look the same on the page: a beat
 * that repeats the beat before it, and a scene intent that is its beat handed
 * back in different words. Both are cheap for a model to produce under pressure
 * and both are invisible to a schema.
 */

/**
 * Words that carry no story. Almost every beat contains "the camera", so
 * counting those makes any two beats in the same project look alike — the
 * thresholds that use this are meaningless without the list.
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

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !IGNORED.has(word)),
  );
}

function shared(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of b) if (a.has(word)) count += 1;
  return count;
}

/**
 * Jaccard overlap, 0 to 1. Symmetric, so it answers "are these the same thing",
 * which is the question to ask of two consecutive beats.
 */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const both = shared(a, b);
  return both / (a.size + b.size - both);
}

/**
 * How much of `b` is already in `a`, 0 to 1. Asymmetric on purpose: an intent
 * that adds nothing to its beat scores 1 however long the beat is, which a
 * symmetric measure would dilute.
 */
export function containment(a: Set<string>, b: Set<string>): number {
  if (b.size === 0) return 0;
  return shared(a, b) / b.size;
}
