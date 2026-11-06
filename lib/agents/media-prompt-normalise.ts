import type { ModelFamily } from "@/lib/wangp/family";
import { shotSizeOf } from "@/lib/media/seam";
import {
  cleanPunctuation,
  dedupeSentences,
  lintRendered,
  splitSentences,
  type BudgetContext,
  type LintFinding,
  type MediaPromptSpec,
} from "@/lib/agents/media-prompt-spec";
import { framingOpening } from "@/lib/agents/media-prompt-renderers";
import { SHOT_LABELS, stripFraming } from "@/lib/agents/media-prompt-builder";

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

// "Low camera angle", "knee level" and "chest height" are camera heights as
// much as "low angle" is. Missing them flagged correctly framed prompts with
// "does not open with shot size and camera height".
const HEIGHT_PATTERN =
  /\b(eye[-\s]level|(?:low|high)(?:[-\s]camera)?[-\s]angle|(?:low|high)[-\s]camera|dutch|canted|overhead|top[-\s]down|bird'?s[-\s]eye|worm'?s[-\s]eye|from (?:above|below)|(?:shoulder|chest|waist|hip|knee|ground|floor|head)[-\s](?:level|height)|over[-\s]the[-\s]shoulder)\b/i;

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
 * Put the framing first when a model-authored keyframe prompt left it out.
 *
 * Partial framing the model did state wins over the supplied defaults, and the
 * phrases it is promoted from are taken out of the sentence they were in, so
 * the size is never stated twice.
 */
export function withFramingFirst(
  text: string,
  framing: MediaPromptSpec["framing"],
): { text: string; repaired: boolean } {
  if (!text.trim() || opensWithFraming(text)) return { text, repaired: false };
  const [first = "", ...rest] = splitSentences(text);
  const shot = shotSizeOf(first);
  const height = first.match(HEIGHT_PATTERN)?.[0];
  const opening = framingOpening({
    framing: {
      ...framing,
      ...(shot ? { shotSize: SHOT_LABELS[shot] } : {}),
      ...(height ? { cameraHeight: height } : {}),
    },
  } as MediaPromptSpec);
  return {
    text: cleanPunctuation(`${opening} ${stripFraming(first)} ${rest.join(" ")}`),
    repaired: true,
  };
}

/**
 * Normalise one model-authored image prompt.
 *
 * Supply missing framing without introducing a second, incompatible shot size.
 * Partial framing already stated by the model wins over the card's defaults.
 */
export function normaliseImagePrompt(
  text: string,
  spec: MediaPromptSpec,
  family: ModelFamily,
  budget: BudgetContext = {},
): NormalisedPrompt {
  const cleaned = cleanPunctuation(dedupeSentences(cleanPunctuation(text)));
  const framed = withFramingFirst(cleaned, spec.framing);
  const final = cleanPunctuation(framed.text);
  return {
    text: final,
    findings: lintRendered(final, family, "image", 0, budget),
    framingRepaired: framed.repaired,
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
  budget: BudgetContext = {},
): NormalisedPrompt {
  const final = cleanPunctuation(dedupeSentences(cleanPunctuation(text)));
  return {
    text: final,
    findings: lintRendered(final, family, "video", segmentSeconds, budget),
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
  // Wording is held to word for word, punctuation and case are not: a model
  // that writes "hips, you want" for "hips. You want" has kept the line, and
  // treating that as dropped sent whole runs to the fallback.
  const plain = (value: string) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const haystack = plain(text);
  return dialogue
    .map((d) => d.line.trim())
    .filter((line) => line && !haystack.includes(plain(line)));
}

/**
 * Phrases that mean the model narrated its brief instead of writing the scene.
 *
 * A video model renders these words rather than obeying them, so "the robot
 * performs its dominant action" puts the instruction in the picture and spends
 * part of a finite prompt budget doing it. The directives avoid naming the
 * structure for this reason; this catches it when a model names it anyway.
 */
const INSTRUCTION_ECHOES = [
  /\b(dominant|primary) (action|motion|movement)\b/i,
  /\bsecondary (action|motion|movement)\b/i,
  /\bthe (prompt|scene|shot|clip) (should|must|will)\b/i,
  /\bas (instructed|directed|requested)\b/i,
  /\bper the (brief|instructions?|directive)\b/i,
];

export function echoesInstructions(text: string): string[] {
  return INSTRUCTION_ECHOES.flatMap((pattern) => {
    const hit = pattern.exec(text);
    return hit ? [hit[0]] : [];
  });
}

const UPRIGHT = /\b(stands?|standing|walks?|walking|approach(?:es|ing)?|steps?|stepping|on (?:his|her|their) feet)\b/i;
const LOWERED = /\b(sits?|sitting|seated|kneels?|kneeling|lies?|lying|lies back|reclin(?:es|ing)|crouch(?:es|ing)|perched)\b/i;

/**
 * Does one frame ask for a person on their feet and a person off them, in a
 * shot too tight to hold both?
 *
 * Measured, not reasoned: at 16:9 a standing figure and seated figures cannot
 * share a keyframe with every head in view. The model anchors the framing on
 * whoever dominates and crops the outlier at the neck — and a head missing from
 * a carried frame is a person deleted from the scene that inherits it. Holding
 * the seed and changing one thing at a time, a lower camera did not fix it and
 * neither did a wider shot; seating everyone did, first attempt.
 *
 * A shot already framed wide is left alone: it has room for the height
 * difference, and warning about it would only teach people to ignore this.
 *
 * A warning rather than a rewrite. The staging is the author's, and mixed
 * heights are legitimate — they just have to be framed deliberately.
 */
export function mixesStandingAndSeated(text: string): boolean {
  const body = text.split(/\bCharacter continuity\b/i)[0] ?? text;
  if (!UPRIGHT.test(body) || !LOWERED.test(body)) return false;
  const shot = shotSizeOf(text.slice(0, LEAD_CHARS));
  return shot !== "wide" && shot !== "extreme_wide" && shot !== "full";
}
