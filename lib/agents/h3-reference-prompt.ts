import { markDialogue, stripDialogueMarkup } from "@/lib/agents/h3-prompt";
import type { ModelFamily } from "@/lib/wangp/family";

/**
 * MiniMax H3's reference-mode prompt format.
 *
 * Ref2VA is not FL2VA with extra pictures. FL2VA pins its two keyframes
 * positionally and is told, in one sentence, where in time they land. Ref2VA
 * has no positional input at all: every image arrives as an undifferentiated
 * `<Picture N>` in supplied order, and what each one *means* — opening frame,
 * closing frame, this character's face — exists only because the prompt says
 * so. Get the prose wrong and the model still renders something; it just
 * renders it from the wrong references. A live run that named only a start
 * frame lost the composition entirely and pushed the referenced character into
 * the background.
 *
 * So this format is load-bearing in a way the FL2VA envelope is not, and it is
 * used unconditionally rather than behind a flag. It also has live evidence
 * behind it that the envelope lacks: the 13.67s run that held identity for a
 * full clip and delivered lip-synced dialogue was prompted exactly this way.
 *
 * Six sections in the order `VIDEO_PROMPT_WRITING_GUIDE_ref_en` gives them.
 * Two rules from that guide shape the structure and are easy to get backwards:
 *
 *   - A photograph that exists only to define a character is cited **inside**
 *     that character's `<Subject N>` line. It does not also get a standalone
 *     `<Picture N>` entry, or the model treats the photo's own setting and
 *     composition as something to reproduce.
 *   - A frame anchor is the opposite: it gets its own entry, because the whole
 *     point of it is the composition.
 *
 * Picture numbers are absolute positions in the reference list WanGP is handed,
 * not per-section counters — `text_encoder.py` emits `<Picture N>` in upload
 * order and nothing renumbers them.
 */

/** The reference list order this format assumes — see FR-3. */
export type H3ReferenceSubject = {
  name: string;
  /** Wardrobe and physical description, as the storyboard states it. */
  description?: string;
  /** 1-based position of this character's photograph in the reference list. */
  pictureIndex: number;
  /**
   * How much of the reference the model should carry over. The guide's four
   * markers; identity work wants `attribute_transfer`, which takes the face
   * without the photograph's pose, framing or clothing.
   */
  retention?: H3Retention;
};

export type H3Retention =
  | "fully_preserved"
  | "partially_preserved"
  | "attribute_transfer"
  | "weak_reference";

export type H3ReferencePromptParts = {
  /** The timeline prose, without the `[Shot 1]` marker. */
  body: string;
  /** One or two sentences naming the visual style, placed before `[Shot 1]`. */
  style?: string;
  /** One or two sentences of what happens, after the task-type marker. */
  summary?: string;
  subjects: readonly H3ReferenceSubject[];
  hasStart: boolean;
  hasEnd: boolean;
  /** Ambience and physical sound. Empty falls back to the guide's `N/A`. */
  soundscape?: string;
  /** Audience-only score. Empty means there is none, which the guide writes `N/A`. */
  score?: string;
};

/**
 * The length MiniMax ask `detailed_description` to reach.
 *
 * A floor to report against, never to pad to: the motion budget is what breaks
 * when a prompt is lengthened by adding events, and padding is the one way of
 * hitting a word count that makes the clip worse.
 */
export const H3_REFERENCE_MIN_WORDS = 350;

const SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

const SHOT = "[Shot 1]";

function tidy(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function countWords(value: string): number {
  const trimmed = tidy(value);
  return trimmed ? trimmed.split(" ").length : 0;
}

/**
 * The bracketed marker `summary` opens with.
 *
 * It names which of H3's reference jobs this is, and the two halves are
 * independent: anchoring frames is "keyframe completion", carrying a face in
 * from a photograph is "reference generation". A scene with both does both.
 */
export function h3ReferenceTaskType(hasAnchors: boolean, hasSubjects: boolean): string {
  if (hasAnchors && hasSubjects) return "[keyframe completion + reference generation]";
  if (hasAnchors) return "[keyframe completion]";
  if (hasSubjects) return "[reference generation]";
  return "[text to video]";
}

/** Where each anchor frame sits in the reference list, per FR-3. */
function anchorLines(hasStart: boolean, hasEnd: boolean): string[] {
  const lines: string[] = [];
  if (hasStart) lines.push("<Picture 1>: the first frame of the target video.");
  if (hasEnd) lines.push(`<Picture ${hasStart ? 2 : 1}>: the last frame of the target video.`);
  return lines;
}

function subjectLine(subject: H3ReferenceSubject, index: number): string {
  const described = tidy(subject.description);
  const detail = described ? ` ${described}` : "";
  return (
    `<Subject ${index + 1}>: ${tidy(subject.name)}, whose appearance is defined by ` +
    `<Picture ${subject.pictureIndex}>.${detail}`
  );
}

/**
 * One retention line per label, with its marker.
 *
 * The guide wants this stated rather than inferred, and the two kinds of
 * reference want opposite answers: an anchor frame is reproduced, a face is
 * transferred onto a person the anchor already composed.
 */
function retentionLines(
  hasStart: boolean,
  hasEnd: boolean,
  subjects: readonly H3ReferenceSubject[],
): string[] {
  const lines = anchorLines(hasStart, hasEnd).map((line) => {
    const label = line.slice(0, line.indexOf(":"));
    return `${label}: fully_preserved — composition, setting and lighting are reproduced exactly.`;
  });

  subjects.forEach((subject, index) => {
    const marker = subject.retention ?? "attribute_transfer";
    lines.push(
      `<Subject ${index + 1}>: ${marker} — facial identity is carried over; the photograph's ` +
        "own pose, framing, wardrobe and background are not.",
    );
  });

  return lines;
}

/**
 * Assemble the six sections.
 *
 * One shot only, for the same reason as FL2VA: a StoryForge scene is one
 * continuous take by construction, and the guide warns that multi-shot prompts
 * make the model cut.
 */
export function renderH3ReferencePrompt(parts: H3ReferencePromptParts): string {
  const hasAnchors = parts.hasStart || parts.hasEnd;
  const subjects = parts.subjects;

  const definitions = [
    ...anchorLines(parts.hasStart, parts.hasEnd),
    ...subjects.map(subjectLine),
  ];

  const body = markDialogue(tidy(parts.body));
  const timeline = body.startsWith(SHOT) ? body : `${SHOT} ${body}`;
  const style = tidy(parts.style);

  const values: Record<(typeof SECTIONS)[number], string> = {
    subject_definitions: definitions.join("\n") || "N/A",
    summary: `${h3ReferenceTaskType(hasAnchors, subjects.length > 0)} ${
      tidy(parts.summary) || "Continuous single shot."
    }`.trim(),
    retention_analysis: retentionLines(parts.hasStart, parts.hasEnd, subjects).join("\n") || "N/A",
    detailed_description: style ? `${style} ${timeline}` : timeline,
    overall_soundscape: tidy(parts.soundscape) || "N/A",
    non_diegetic_music: tidy(parts.score) || "N/A",
  };

  return SECTIONS.map((section) => `${section}: ${values[section]}`).join("\n\n");
}

/** Whether a prompt is already in this format. */
export function isH3ReferencePrompt(prompt: string): boolean {
  return prompt.includes("subject_definitions:");
}

/**
 * Recover plain prose from the six sections.
 *
 * Same reason the envelope has a stripper: a prompt is written for the pinned
 * model, but a pin can be missing from the catalogue and fall through to the
 * router, so the family a prompt was written for is not always the family that
 * renders it. The labels would otherwise be rendered as words.
 *
 * The reference bookkeeping is dropped rather than folded back in — it
 * describes pictures a non-reference model is not being sent — while the
 * timeline and both audio layers survive, because those are direction.
 */
export function stripH3ReferencePrompt(prompt: string): string {
  if (!isH3ReferencePrompt(prompt)) return stripDialogueMarkup(prompt);

  const section = (name: string): string => {
    const pattern = new RegExp(
      `(?:^|\\n)\\s*${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${SECTIONS.join("|")}):|$)`,
    );
    return tidy(pattern.exec(prompt)?.[1]);
  };

  return [
    section("detailed_description").replace(/\[Shot 1\]\s*/g, ""),
    section("overall_soundscape"),
    section("non_diegetic_music"),
  ]
    .filter((value) => value && value !== "N/A")
    .map(stripDialogueMarkup)
    .join(" ")
    .trim();
}

/** Only the reference variant takes this format — FL2VA has its own. */
export function usesH3ReferenceFormat(family: ModelFamily): boolean {
  return family === "minimax_ref2va";
}
