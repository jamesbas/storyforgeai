/**
 * Which of a LoRA's trigger words actually go into the prompt.
 *
 * Trigger words are not always additive. A multi-concept LoRA uses them as a
 * *selector* — one file might offer several mutually exclusive behaviours, and
 * appending all of them asks for contradictory things at once. A style LoRA, by
 * contrast, may genuinely want two words together.
 *
 * The catalog cannot tell those apart, so the choice belongs to the user:
 *
 *  - one trigger word  → unambiguous, used automatically
 *  - several           → nothing is used until the user picks, because guessing
 *                        wrong silently corrupts the prompt
 *  - explicit choice   → honoured exactly, including an explicit "none"
 *
 * Kept free of runtime dependencies so the server (at generation) and the
 * browser (previewing what will be appended) apply the identical rule.
 */
export function effectiveTriggerWords(
  chosen: readonly string[] | undefined,
  available: readonly string[],
): string[] {
  if (!available.length) return [];

  // `undefined` means "never chosen", which is different from "chose none".
  if (chosen) {
    // Drop anything the LoRA no longer offers, so a stale choice cannot survive
    // the LoRA being updated or replaced.
    const offered = new Set(available);
    return chosen.filter((word) => offered.has(word));
  }

  return available.length === 1 ? [...available] : [];
}

/** True when a LoRA needs a decision the user has not made yet. */
export function needsTriggerChoice(
  chosen: readonly string[] | undefined,
  available: readonly string[],
): boolean {
  return available.length > 1 && chosen === undefined;
}
