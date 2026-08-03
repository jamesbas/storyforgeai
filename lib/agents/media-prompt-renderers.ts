import type { ModelFamily } from "@/lib/wangp/family";
import {
  cleanPunctuation,
  countWords,
  dedupeSentences,
  splitSentences,
  wordBudget,
  type MediaPromptSpec,
} from "@/lib/agents/media-prompt-spec";

/**
 * Family renderers: one spec, five house styles (SPEC-003 FR-2 to FR-5).
 *
 * The families genuinely disagree about what a good prompt looks like, and the
 * disagreements are load-bearing rather than cosmetic. Wan's published
 * image-to-video formula is motion plus camera and nothing else; LTX wants one
 * flowing present-tense paragraph and writes its soundtrack from the same text;
 * Qwen is literal about ordering; FLUX and Krea have no dependable negative
 * prompt, so exclusions must be phrased as what to render instead.
 */

/** One sentence: terminated, and capitalised because spec fields rarely are. */
function clause(text: string | undefined): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  const raised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(raised) ? raised : `${raised}.`;
}

/** Lower-cases an opening letter so a field can be inlined mid-sentence. */
function inline(text: string | undefined): string {
  const trimmed = (text ?? "").trim().replace(/[.!?]+$/, "");
  if (!trimmed) return "";
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * The opening every image prompt must have: shot size, camera height, then lens
 * when one is known (FR-2). Traces showed the old builders opening with
 * "Cinematic still" and never stating height at all.
 */
export function framingOpening(spec: MediaPromptSpec): string {
  const parts = [spec.framing.shotSize.trim(), spec.framing.cameraHeight.trim()];
  if (spec.framing.lens?.trim()) parts.push(spec.framing.lens.trim());
  return `${parts.filter(Boolean).join(", ")}.`;
}

/**
 * Speech rendered the way LTX-2 expects it: quoted inline in the prose, not as
 * a separate script block. This is the format in WanGP's own LTX-2 defaults and
 * is how spoken audio reaches the clip — nothing is synthesised separately.
 *
 * Lines are verbatim. Inner double quotes become single so the delimiter stays
 * unambiguous, which is the only alteration made.
 */
export function dialogueClause(spec: MediaPromptSpec): string {
  if (!spec.dialogue.length) return "";
  const spoken = spec.dialogue
    .map((d) => `${d.speaker} says, "${d.line.replace(/"/g, "'")}"`)
    .join(" ");
  return `${spoken} Lip movement matches the spoken words.`;
}

/**
 * Trim to a word budget without ever cutting dialogue or the framing opening.
 *
 * Budgets are enforced by dropping optional style clauses from the end, which
 * is the precedence SPEC-003 asks for: dialogue is authoritative, so optional
 * global style goes first.
 */
export function trimToBudget(text: string, budget: number, protectedPrefixSentences = 1): string {
  if (countWords(text) <= budget) return text;
  const sentences = splitSentences(text);
  const kept: string[] = [];
  let words = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    const cost = countWords(sentence);
    const isProtected = i < protectedPrefixSentences || /["“]/.test(sentence);
    if (!isProtected && words + cost > budget) continue;
    kept.push(sentence);
    words += cost;
  }
  return kept.join(" ");
}

function finish(text: string, budget: number, protectedPrefix = 1): string {
  const cleaned = trimToBudget(
    cleanPunctuation(dedupeSentences(cleanPunctuation(text))),
    budget,
    protectedPrefix,
  );
  // Spec fields are phrased to sit mid-sentence, so the opening needs raising.
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
}

export type ImageRenderOptions = {
  family: ModelFamily;
  /** Which end of the segment this frame sits at. */
  frame: "start" | "end";
};

/**
 * Render one still.
 *
 * Order is the same for every family — framing, subject, composition, setting,
 * lighting, frame action — because that ordering is what FR-2 and FR-3 require.
 * Qwen gets an explicit no-lettering note, since it is the one family that
 * renders text it was never asked for.
 */
export function renderImagePrompt(spec: MediaPromptSpec, options: ImageRenderOptions): string {
  const state = options.frame === "start" ? spec.startState : spec.endState;
  const parts = [
    framingOpening(spec),
    clause(spec.subject),
    clause(spec.composition),
    spec.setting.trim() ? clause(`The setting is ${inline(spec.setting)}`) : "",
    spec.lighting.trim() ? clause(`Lighting: ${inline(spec.lighting)}`) : "",
    clause(state),
    ...spec.continuity.map(clause),
  ];

  if (options.family === "qwen" && !/["“]/.test(spec.subject + spec.setting)) {
    parts.push("No lettering or signage in frame.");
  }

  return finish(parts.filter(Boolean).join(" "), wordBudget(options.family, "image", 0));
}

export type VideoRenderOptions = {
  family: ModelFamily;
  segmentSeconds: number;
  /** LTX writes its own soundtrack from this text. */
  nativeAudio: boolean;
};

function normaliseForCompare(text: string | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The closing clause, omitted when it would only restate the action.
 *
 * A scene card has no end-state field, so the end state is derived from the
 * action — which makes "she seats the gear. It ends on she seats the gear" an
 * easy tautology to emit. Saying nothing beats saying it twice.
 */
function endClause(spec: MediaPromptSpec, lead: string): string {
  const end = spec.endState.trim();
  if (!end) return "";
  const endKey = normaliseForCompare(end);
  const motionKey = normaliseForCompare(spec.dominantMotion);
  if (
    !endKey ||
    endKey === motionKey ||
    (motionKey && motionKey.startsWith(endKey)) ||
    (endKey && motionKey && endKey.startsWith(motionKey))
  ) {
    return "";
  }
  return clause(`${lead} ${inline(end)}`);
}

/**
 * Render the clip prompt, motion first (FR-4).
 *
 * The old builder opened with the scene's static description repeated three
 * times and reached the camera in the fourth sentence. Every family here opens
 * with what moves, because that is what an image-to-video model is being asked
 * for — the start frame already carries the appearance.
 */
export function renderVideoPrompt(spec: MediaPromptSpec, options: VideoRenderOptions): string {
  const { family, segmentSeconds } = options;
  const budget = wordBudget(family, "video", segmentSeconds);

  if (family === "wan") {
    // Motion plus camera and nothing more, per Wan's published formula. The
    // duration still leads: it is what the action has to be paced against.
    const parts = [
      clause(`Over ${segmentSeconds} seconds, ${inline(spec.dominantMotion)}`),
      clause(spec.secondaryMotion),
      clause(spec.cameraMotion ? `The camera ${inline(spec.cameraMotion)}` : "Fixed camera, unchanged framing"),
      endClause(spec, "It ends on"),
      dialogueClause(spec),
    ];
    return finish(parts.filter(Boolean).join(" "), budget);
  }

  if (family === "ltx") {
    // One flowing present-tense paragraph, with room for speech.
    const parts = [
      clause(`Over ${segmentSeconds} seconds, ${inline(spec.dominantMotion)}`),
      clause(spec.secondaryMotion),
      clause(spec.cameraMotion ? `The camera ${inline(spec.cameraMotion)}` : "The camera holds still"),
      endClause(spec, "The shot settles on"),
      options.nativeAudio && spec.setting.trim() ? clause(`Ambience: ${inline(spec.setting)}`) : "",
      dialogueClause(spec),
      spec.narration?.trim() ? clause(`Voice-over: "${spec.narration.trim().replace(/"/g, "'")}"`) : "",
      ...spec.continuity.map(clause),
    ];
    return finish(parts.filter(Boolean).join(" "), budget);
  }

  const parts = [
    clause(`Over ${segmentSeconds} seconds, ${inline(spec.dominantMotion)}`),
    clause(spec.secondaryMotion),
    clause(spec.cameraMotion ? `The camera ${inline(spec.cameraMotion)}` : "Fixed camera"),
    endClause(spec, "It ends on"),
    dialogueClause(spec),
    spec.narration?.trim() ? clause(`Voice-over: "${spec.narration.trim().replace(/"/g, "'")}"`) : "",
    ...spec.continuity.map(clause),
  ];
  return finish(parts.filter(Boolean).join(" "), budget);
}

/**
 * Fold exclusions into the positive prompt for families with no dependable
 * negative (FLUX, Krea). Render-time negative routing is unchanged and still
 * owns the real decision; this only shapes what the composer emits.
 */
export function positiveExclusions(spec: MediaPromptSpec, family: ModelFamily): string {
  if (family !== "flux" && family !== "krea") return "";
  if (!spec.exclusions.length) return "";
  return ` ${spec.exclusions.map(clause).join(" ")}`;
}
