import type { ModelFamily } from "@/lib/wangp/family";
import { shotSizeOf } from "@/lib/media/seam";
import {
  cleanPunctuation,
  dedupeSentences,
  lintRendered,
  type LintFinding,
  type MediaPromptSpec,
} from "@/lib/agents/media-prompt-spec";
import { framingOpening } from "@/lib/agents/media-prompt-renderers";

/**
 * Hold model-authored prompts to the same semantic contract as the
 * deterministic ones (SPEC-003 FR-7).
 *
 * The system prompts already ask for framing-first openings and verbatim
 * dialogue, but asking is not the same as getting: a model that drops the shot
 * size produces exactly the defect the deterministic path was fixed for, and
 * the two paths silently diverge again.
 *
 * Runs before cast/look/negative enforcement, so the canonical suffixes those
 * append are never mistaken for the model's own repetition.
 */

const HEIGHT_PATTERN =
  /\b(eye[-\s]level|low[-\s]angle|high[-\s]angle|dutch|canted|overhead|bird'?s[-\s]eye|worm'?s[-\s]eye|from (?:above|below)|shoulder height|over[-\s]the[-\s]shoulder)\b/i;

/** How much of the opening counts as "opens with". */
const LEAD_CHARS = 120;

export function opensWithFraming(text: string): boolean {
  const lead = text.slice(0, LEAD_CHARS);
  return Boolean(shotSizeOf(lead)) && HEIGHT_PATTERN.test(lead);
}

export type NormalisedPrompt = {
  text: string;
  findings: LintFinding[];
  /** True when framing had to be prepended because the model omitted it. */
  framingRepaired: boolean;
};

/**
 * Normalise one model-authored image prompt.
 *
 * Framing is prepended rather than rewritten: the model's own words are kept
 * intact, and the derived opening only supplies what was missing. Rewriting
 * would discard the creative choice this path exists to preserve.
 */
export function normaliseImagePrompt(
  text: string,
  spec: MediaPromptSpec,
  family: ModelFamily,
): NormalisedPrompt {
  const cleaned = cleanPunctuation(dedupeSentences(cleanPunctuation(text)));
  const framingRepaired = !opensWithFraming(cleaned);
  const repaired = framingRepaired ? `${framingOpening(spec)} ${cleaned}` : cleaned;
  const final = cleanPunctuation(repaired);
  return {
    text: final,
    findings: lintRendered(final, family, "image", 0),
    framingRepaired,
  };
}

/**
 * Normalise one model-authored video prompt.
 *
 * Framing is deliberately not enforced here — the clip renders from a start
 * frame that already fixes it, and spending the prompt restating framing is the
 * failure the video contract exists to avoid.
 */
export function normaliseVideoPrompt(
  text: string,
  family: ModelFamily,
  segmentSeconds: number,
): NormalisedPrompt {
  const final = cleanPunctuation(dedupeSentences(cleanPunctuation(text)));
  return {
    text: final,
    findings: lintRendered(final, family, "video", segmentSeconds),
    framingRepaired: false,
  };
}

/**
 * Whether every line of dialogue survived into the prompt.
 *
 * The video system prompt insists dialogue is carried word for word because it
 * is what the model speaks, but a summarising model drops it and the clip comes
 * back with a two-word bark. Comparing against the card is the only way to know.
 */
export function missingDialogue(
  text: string,
  dialogue: readonly { line: string }[],
): string[] {
  const haystack = text.replace(/['"“”‘’]/g, "").toLowerCase();
  return dialogue
    .map((d) => d.line.trim())
    .filter((line) => line && !haystack.includes(line.replace(/['"“”‘’]/g, "").toLowerCase()));
}
