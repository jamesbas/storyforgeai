import type { ModelFamily } from "@/lib/wangp/family";
import type { DialogueMode } from "@/lib/types";
import { SPEECH_VERB_PATTERN } from "@/lib/agents/speech-verbs";
import {
  DEFAULT_PROMPT_BUDGET_SETTINGS,
  type PromptBudgetSettings,
} from "@/lib/schemas/prompt-budget-settings";

/**
 * What a word ceiling depends on beyond the model: the user's saved limits and,
 * for stills, how many people the frame has to hold.
 */
export type BudgetContext = {
  settings?: PromptBudgetSettings;
  people?: number;
};

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
export const COMPOSER_VERSION = "media-composer-v4";

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
  /** How much of the scene is meant to be spoken; inferred from `dialogue` when absent. */
  dialogueMode?: DialogueMode;
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
  | "dialogue_under_budget"
  | "dialogue_over_budget"
  | "dialogue_in_silent_scene"
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

/**
 * How much of a scene is spoken.
 *
 * `full` carries a conversation through most of the clip, `brief` one short
 * line or exchange, `silent` none. A single project-wide "dialogue on" flag
 * made every scene speak at conversation length, so wordless beats were padded
 * with filler and talking scenes had nothing telling them to keep going.
 */
export { DIALOGUE_MODES, type DialogueMode } from "@/lib/types";

/** Below this much speech time a `full` scene is written and checked as `brief`. */
export const MIN_FULL_SPEECH_SECONDS = 4;

export function dialogueWordBudget(seconds: number): number {
  return Math.max(1, Math.round(seconds * WORDS_PER_SECOND));
}

export type DialogueWordTargets = {
  minimum: number;
  targetMin: number;
  targetMax: number;
  maximum: number;
};

/**
 * Word bounds for a scene of this length and mode.
 *
 * `full` aims at 68–84% of the clip: enough that speech carries the scene, with
 * room left for turn-taking pauses and lip-sync settling so the last line is
 * not clipped at the final frame. Every bound is clamped to the clip's capacity.
 */
export function dialogueWordTargets(seconds: number, mode: DialogueMode = "full"): DialogueWordTargets {
  if (mode === "silent" || seconds <= 0) return { minimum: 0, targetMin: 0, targetMax: 0, maximum: 0 };
  const capacity = dialogueWordBudget(seconds);
  if (mode === "brief") {
    return {
      minimum: 1,
      targetMin: Math.min(capacity, Math.max(3, Math.round(capacity * 0.12))),
      targetMax: Math.min(capacity, Math.max(10, Math.round(capacity * 0.36))),
      maximum: Math.min(capacity, Math.max(15, Math.round(capacity * 0.45))),
    };
  }
  const minimum = Math.min(capacity, Math.ceil(capacity * 0.6));
  const targetMin = Math.min(capacity, Math.max(minimum, Math.round(capacity * 0.68)));
  const targetMax = Math.min(capacity, Math.max(targetMin, Math.round(capacity * 0.84)));
  return { minimum, targetMin, targetMax, maximum: capacity };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Remove `(whispers)`, `[sighs]` and `*laughs*`: direction, not speech. */
export function stripStageDirections(line: string): string {
  return line.replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, " ");
}

/** Words actually said aloud, so a stage direction never counts as speech time. */
export function countSpokenWords(lines: readonly { line: string }[]): number {
  return countWords(lines.map((entry) => stripStageDirections(entry.line)).join(" "));
}

/** Seconds left for on-screen speech once any voice-over has had its share. */
export function effectiveSpeechSeconds(sceneSeconds: number, narrationText?: string | null): number {
  const narrationSeconds = narrationText?.trim() ? countWords(narrationText) / WORDS_PER_SECOND : 0;
  return Math.max(0, Number((sceneSeconds - narrationSeconds).toFixed(2)));
}

/**
 * The mode a scene behaves as. A stored mode wins; a scene written before modes
 * existed is `full` when it has spoken words and `silent` when it has none, so
 * nothing stored has to be rewritten.
 */
export function inferDialogueMode(
  dialogue: readonly { line: string }[] | null | undefined,
  stored?: DialogueMode | null,
): DialogueMode {
  if (stored) return stored;
  return countSpokenWords(dialogue ?? []) > 0 ? "full" : "silent";
}

export type SpeechOptions = {
  mode?: DialogueMode | null;
  narrationText?: string | null;
};

export type SceneSpeechTargets = DialogueWordTargets & {
  /** The stored or inferred mode. */
  mode: DialogueMode;
  /** The mode the targets were computed for: `brief` when voice-over leaves too little room for `full`. */
  targetMode: DialogueMode;
  seconds: number;
  /** Seconds left for speech after any voice-over. */
  effectiveSeconds: number;
  narrationSeconds: number;
};

/**
 * Targets for one scene, after voice-over and mode are accounted for.
 *
 * The single place the writer, the lint and the editor read from, so the number
 * a model is told to aim at and the number the lint enforces cannot drift apart.
 */
export function sceneSpeechTargets(
  dialogue: readonly { line: string }[] | null | undefined,
  seconds: number,
  options: SpeechOptions = {},
): SceneSpeechTargets {
  const mode = inferDialogueMode(dialogue, options.mode);
  const effectiveSeconds = effectiveSpeechSeconds(seconds, options.narrationText);
  const targetMode = mode === "full" && effectiveSeconds < MIN_FULL_SPEECH_SECONDS ? "brief" : mode;
  return {
    mode,
    targetMode,
    seconds,
    effectiveSeconds,
    narrationSeconds: Number((seconds - effectiveSeconds).toFixed(2)),
    ...dialogueWordTargets(effectiveSeconds, targetMode),
  };
}

function voiceOverNote(targets: SceneSpeechTargets): string {
  return targets.narrationSeconds > 0
    ? ` after about ${targets.narrationSeconds.toFixed(1)}s of voice-over`
    : "";
}

export function lintDialogue(
  dialogue: readonly { line: string }[],
  seconds: number,
  options: SpeechOptions = {},
): LintFinding[] {
  const targets = sceneSpeechTargets(dialogue, seconds, options);
  const spoken = countSpokenWords(dialogue);
  const speechSeconds = (spoken / WORDS_PER_SECOND).toFixed(1);
  if (targets.mode === "silent") {
    return spoken > 0
      ? [{
          code: "dialogue_in_silent_scene",
          severity: "warning",
          message: `This scene is marked Silent but has ${spoken} spoken words. Clear the lines or change its dialogue mode.`,
        }]
      : [];
  }
  if (spoken > targets.maximum) {
    const brief = targets.mode === "brief" ? " That is more than a brief line; mark the scene Full or trim it." : "";
    return [{
      code: "dialogue_over_budget",
      severity: "warning",
      message: `Dialogue runs about ${spoken} words against roughly ${targets.maximum} for ${seconds}s${voiceOverNote(targets)}. It will be rushed or clipped.${brief}`,
    }];
  }
  if (spoken < targets.minimum) {
    if (targets.mode === "brief") {
      return [{
        code: "dialogue_under_budget",
        severity: "warning",
        message: "This scene is marked Brief but has no spoken line. Add a short line or mark it Silent.",
      }];
    }
    const cramped = targets.targetMode === "brief"
      ? ` Voice-over leaves only ${targets.effectiveSeconds.toFixed(1)}s for speech; consider Brief or Silent.`
      : "";
    return [{
      code: "dialogue_under_budget",
      severity: "warning",
      message: `Dialogue has ${spoken} spoken words, about ${speechSeconds}s of speech. Aim for ${targets.targetMin}-${targets.targetMax} words, at least ${targets.minimum}, so speech carries most of this ${seconds}s scene${voiceOverNote(targets)} while the action continues.${cramped} Timing is estimated, not measured audio.`,
    }];
  }
  return [];
}

function normalisedWords(text: string): string {
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
}

const ATTRIBUTED_BEFORE = new RegExp(
  `\\b${SPEECH_VERB_PATTERN}\\b[^"“”.!?\\n]{0,80}$|:\\s*$`,
  "i",
);
const ATTRIBUTED_AFTER = new RegExp(`^[\\s,—-]*(?:[\\p{Lu}][\\p{L}'’-]*\\s+){0,3}${SPEECH_VERB_PATTERN}\\b`, "iu");

/**
 * Words of a video prompt that describe the picture, excluding speech.
 *
 * A quotation is speech when a speech verb introduces it, a colon introduces it
 * (`Ana: "…"`), a speech verb follows it (`"…" Ana says`), or it is one of the
 * scene's own lines. Quoted signage — `a neon sign reading "OPEN"` — is none of
 * those and still counts, because it is something the picture must show.
 */
export function visualWordCount(text: string, dialogue?: readonly { line: string }[] | null): number {
  const lines = (dialogue ?? []).map((entry) => normalisedWords(stripStageDirections(entry.line))).filter(Boolean);
  let result = text.replace(/<d>[\s\S]*?<\/d>/g, " ");
  result = result.replace(/["“]([^"”]*)["”]/g, (quote, inner: string, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 100), offset);
    const after = whole.slice(offset + quote.length, offset + quote.length + 60);
    const words = normalisedWords(inner);
    const isLine = Boolean(words) && lines.some((line) => line === words || line.includes(words) || words.includes(line));
    return isLine || ATTRIBUTED_BEFORE.test(before) || ATTRIBUTED_AFTER.test(after) ? " " : quote;
  });
  return countWords(result);
}

/**
 * Word ceiling per family and segment length.
 *
 * Wan's published image-to-video formula is motion plus camera and nothing
 * more, so it gets the tightest budget. Video budgets cover visual prose;
 * verbatim speech is additional and has its own duration check.
 */
export function wordBudget(
  family: ModelFamily,
  kind: "image" | "video",
  seconds: number,
  budget: BudgetContext = {},
): number {
  const settings = budget.settings ?? DEFAULT_PROMPT_BUDGET_SETTINGS;
  if (kind === "image") {
    const base = settings.imageWords ?? (family === "qwen" ? 140 : 120);
    const extra = Math.max(0, Math.floor(budget.people ?? 1) - 1) * settings.wordsPerExtraPerson;
    return Math.min(Math.max(settings.imageMaxWords, base), base + extra);
  }
  if (settings.videoWords !== null) return settings.videoWords;
  switch (family) {
    case "wan":
      return Math.min(90, 45 + Math.round(seconds * 2));
    case "ltx":
      return Math.min(160, 70 + Math.round(seconds * 4));
    default:
      return Math.min(140, 60 + Math.round(seconds * 4));
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
  findings.push(...lintDialogue(spec.dialogue, segmentSeconds, {
    mode: spec.dialogueMode,
    narrationText: spec.narration,
  }));
  return findings;
}

/** Checks on the rendered string, after the family renderer and enforcement. */
export function lintRendered(
  text: string,
  family: ModelFamily,
  kind: "image" | "video",
  seconds: number,
  budgetContext: BudgetContext = {},
  /** The scene's lines, so speech the prompt quotes without a verb is not counted as visual prose. */
  dialogue?: readonly { line: string }[] | null,
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
  const budget = wordBudget(family, kind, seconds, budgetContext);
  const words = kind === "video" ? visualWordCount(text, dialogue) : countWords(text);
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
