import type { ModelFamily } from "@/lib/wangp/family";

/**
 * The semantic contract every media prompt must satisfy, whichever path wrote
 * it (SPEC-003).
 *
 * The deterministic builders and the LLM agents used to produce prompts that
 * were both schema-valid and semantically unequal: the builders opened with
 * "Cinematic still", never stated camera height, and repeated the scene's
 * static description three times in a video prompt whose job was motion. This
 * is the shared intermediate both paths now produce, so the requirements are
 * stated once and tested once.
 *
 * Structure covers production constraints only. `subject`, `startState` and
 * `endState` stay freeform, because pinning those down is how a composer starts
 * writing worse prose than the model it replaced.
 */

/** Bumped when the rendered output changes materially. Recorded per execution. */
export const COMPOSER_VERSION = "media-composer-v2";

export type ShotFraming = {
  /** "Medium shot", "Extreme close-up" — the first thing an image prompt says. */
  shotSize: string;
  /** "eye level", "low angle" — the second. */
  cameraHeight: string;
  /** "50mm" when the plan names one. Omitted rather than invented. */
  lens?: string;
};

export type SpecDialogue = {
  speaker: string;
  /** Verbatim. Never paraphrased, never trimmed to fit a budget. */
  line: string;
};

export type MediaPromptSpec = {
  framing: ShotFraming;
  subject: string;
  setting: string;
  lighting: string;
  composition?: string;
  /** What the frame shows at the top of the segment. */
  startState: string;
  /** What it shows at the end — the thing that makes the clip a clip. */
  endState: string;
  dominantMotion?: string;
  secondaryMotion?: string;
  cameraMotion?: string;
  dialogue: SpecDialogue[];
  narration?: string;
  continuity: string[];
  exclusions: string[];
};

export type LintCode =
  | "missing_shot_size"
  | "missing_camera_height"
  | "missing_subject"
  | "missing_setting"
  | "missing_lighting"
  | "missing_dominant_motion"
  | "missing_camera_behavior"
  | "missing_end_state"
  | "duplicate_sentence"
  | "punctuation_artifact"
  | "dialogue_over_budget"
  | "over_budget";

export type LintSeverity = "error" | "warning";

export type LintFinding = {
  code: LintCode;
  severity: LintSeverity;
  /** Plain text, so the UI never has to encode meaning in colour alone. */
  message: string;
};

/**
 * Words of speech that fit a segment at natural pace.
 *
 * ~2.5 words/second is conversational delivery. Dialogue is authoritative — it
 * is never trimmed to fit — so exceeding this is a warning telling the author
 * the line will be clipped or rushed, not an error that blocks generation.
 *
 * Exported so the number a model is told to aim at and the number the lint
 * enforces cannot drift apart; they were 2 and 2.5 respectively.
 */
export const WORDS_PER_SECOND = 2.5;

export function dialogueWordBudget(seconds: number): number {
  return Math.max(1, Math.round(seconds * WORDS_PER_SECOND));
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Word ceiling per family and segment length.
 *
 * Wan's published image-to-video formula is motion plus camera and nothing
 * more, so it gets the tightest budget; LTX writes its own soundtrack from the
 * same text and needs room for speech. Image families are not paced by
 * duration at all.
 */
export function wordBudget(family: ModelFamily, kind: "image" | "video", seconds: number): number {
  if (kind === "image") {
    switch (family) {
      case "qwen":
        return 220;
      case "flux":
      case "krea":
        return 200;
      default:
        return 180;
    }
  }
  switch (family) {
    case "wan":
      return Math.min(120, 55 + Math.round(seconds * 3));
    case "ltx":
      return Math.min(320, 90 + Math.round(seconds * 9));
    default:
      return Math.min(200, 70 + Math.round(seconds * 5));
  }
}

/**
 * Split on sentence boundaries, keeping the terminator.
 *
 * Quote-aware, because dialogue is quoted inline for lip sync and a naive split
 * on `[.!?]` cuts `Ana says, "Now."` in half and leaves a stray quote mark in
 * the rendered prompt.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  let quote: '"' | "“" | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    current += char;

    if (quote === null && (char === '"' || char === "“")) {
      quote = char === "“" ? "“" : '"';
      continue;
    }
    if (quote === '"' && char === '"') {
      quote = null;
      continue;
    }
    if (quote === "“" && char === "”") {
      quote = null;
      continue;
    }
    if (quote !== null) continue;

    if (/[.!?]/.test(char)) {
      // Consume a run of terminators and any closing quote that follows.
      while (i + 1 < text.length && /[.!?"”']/.test(text[i + 1])) {
        current += text[i + 1];
        i += 1;
      }
      if (i + 1 >= text.length || /\s/.test(text[i + 1])) {
        sentences.push(current.trim());
        current = "";
      }
    }
  }

  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function normaliseSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/["'“”‘’]/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop repeated sentences, keeping the first occurrence.
 *
 * The old builders pasted `visualDescription` into the start frame, the end
 * frame and the video prompt, then appended plan text that often restated it
 * again. A model given the same sentence twice weights it twice.
 *
 * Sentences containing quoted speech are never dropped: two characters can
 * legitimately say the same words, and dialogue is verbatim.
 */
export function dedupeSentences(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (/["“”]/.test(sentence)) {
      kept.push(sentence);
      continue;
    }
    const key = normaliseSentence(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }
  return kept.join(" ");
}

/**
 * Repair the punctuation artifacts concatenation produces.
 *
 * `Camera: ${cameraMovement.toLowerCase()}, evolving...` rendered as
 * "slow push-in on the subject., evolving" whenever the field ended in a full
 * stop — visible in real traces, and the reason FR-10 exists.
 */
export function cleanPunctuation(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\s*,/g, "$1")
    .replace(/([,;:])\s*\1+/g, "$1")
    .replace(/([.!?])[.!?]+/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\.\s*,/g, ".")
    .replace(/\s*\.\s*\./g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every artifact `cleanPunctuation` is meant to remove, for lint detection. */
const PUNCTUATION_ARTIFACTS = [
  /[.!?]\s*,/,
  /,\s*\./,
  /\s[,.;:]/,
  /([,;:])\s*\1/,
  /[.!?]{2,}/,
  /\(\s*\)/,
];

export function hasPunctuationArtifact(text: string): boolean {
  return PUNCTUATION_ARTIFACTS.some((pattern) => pattern.test(text));
}

function duplicateSentence(text: string): boolean {
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    if (/["“”]/.test(sentence)) continue;
    const key = normaliseSentence(sentence);
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function blank(value: string | undefined): boolean {
  return !value || !value.trim();
}

/**
 * Semantic checks on the spec itself, before any family renders it.
 *
 * Errors mark a spec that cannot satisfy the contract; warnings mark quality
 * problems an author may knowingly accept (FR: errors block, warnings do not).
 */
export function lintImageSpec(spec: MediaPromptSpec): LintFinding[] {
  const findings: LintFinding[] = [];
  if (blank(spec.framing.shotSize)) {
    findings.push({
      code: "missing_shot_size",
      severity: "error",
      message: "Image prompt must open with a shot size.",
    });
  }
  if (blank(spec.framing.cameraHeight)) {
    findings.push({
      code: "missing_camera_height",
      severity: "error",
      message: "Image prompt must state camera height.",
    });
  }
  if (blank(spec.subject)) {
    findings.push({
      code: "missing_subject",
      severity: "error",
      message: "Image prompt must name a primary subject.",
    });
  }
  if (blank(spec.setting)) {
    findings.push({
      code: "missing_setting",
      severity: "warning",
      message: "No setting stated; the model will invent one.",
    });
  }
  if (blank(spec.lighting)) {
    findings.push({
      code: "missing_lighting",
      severity: "warning",
      message: "No lighting stated; on FLUX this is the highest-leverage instruction.",
    });
  }
  return findings;
}

export function lintVideoSpec(spec: MediaPromptSpec, segmentSeconds: number): LintFinding[] {
  const findings: LintFinding[] = [];
  if (blank(spec.dominantMotion)) {
    findings.push({
      code: "missing_dominant_motion",
      severity: "error",
      message: "Video prompt must state one dominant action.",
    });
  }
  if (blank(spec.cameraMotion)) {
    findings.push({
      code: "missing_camera_behavior",
      severity: "warning",
      message: 'No camera behaviour stated; say "fixed camera" if it is locked.',
    });
  }
  if (blank(spec.endState)) {
    findings.push({
      code: "missing_end_state",
      severity: "warning",
      message: "No end state; the movement has nowhere to finish.",
    });
  }
  const spoken = countWords(spec.dialogue.map((d) => d.line).join(" "));
  const budget = dialogueWordBudget(segmentSeconds);
  if (spoken > budget) {
    findings.push({
      code: "dialogue_over_budget",
      severity: "warning",
      message: `Dialogue runs about ${spoken} words against roughly ${budget} for ${segmentSeconds}s. It will be rushed or clipped.`,
    });
  }
  return findings;
}

/** Checks on the rendered string, after the family renderer and enforcement. */
export function lintRendered(
  text: string,
  family: ModelFamily,
  kind: "image" | "video",
  seconds: number,
): LintFinding[] {
  const findings: LintFinding[] = [];
  if (duplicateSentence(text)) {
    findings.push({
      code: "duplicate_sentence",
      severity: "warning",
      message: "A sentence is repeated; the model weights it twice.",
    });
  }
  if (hasPunctuationArtifact(text)) {
    findings.push({
      code: "punctuation_artifact",
      severity: "warning",
      message: "Punctuation artifact from concatenation.",
    });
  }
  const budget = wordBudget(family, kind, seconds);
  const words = countWords(text);
  if (words > budget) {
    findings.push({
      code: "over_budget",
      severity: "warning",
      message: `${words} words against a ${budget}-word budget for ${family || "this family"}.`,
    });
  }
  return findings;
}

export function hasBlockingFinding(findings: readonly LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
