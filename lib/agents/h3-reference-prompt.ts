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
  /**
   * What the two anchor frames show.
   *
   * A render that came out correct describes the contents of each anchor —
   * "showing the poker table, the seated players and the warm overhead
   * practical light" — rather than only labelling it. Without that the model is
   * told a picture is the opening frame but nothing about what it would mean
   * for the opening to match it.
   */
  startFrameDescription?: string;
  endFrameDescription?: string;
  subjects: readonly H3ReferenceSubject[];
  hasStart: boolean;
  hasEnd: boolean;
  /** A source clip supplied through Wan2GP's continuation input. */
  hasVideoSource?: boolean;
  /** Ambience and physical sound. Empty falls back to the guide's `N/A`. */
  soundscape?: string;
  /** Audience-only score. Empty means there is none, which the guide writes `N/A`. */
  score?: string;
};

/**
 * Enough of a keyframe's prompt to say what its picture contains.
 *
 * Taken as a word budget across sentences rather than as the first sentence,
 * because a keyframe prompt is required to open with shot size and camera
 * height — so its first sentence is reliably "Medium close-up, eye level, 35mm
 * lens" and reliably says nothing about what is in the shot. The whole prompt
 * would restate the scene a second time and crowd out the description.
 */
export function summariseFrame(text: string | undefined, maxWords = 45): string {
  const words = tidy(text).split(" ").filter(Boolean);
  if (!words.length) return "";
  const trimmed = words.slice(0, maxWords).join(" ");
  return trimmed.replace(/[.,;:]+$/, "");
}

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
export function h3ReferenceTaskType(
  hasAnchors: boolean,
  hasSubjects: boolean,
  hasVideoSource = false,
): string {
  const tasks = [
    ...(hasVideoSource ? ["video continuation"] : []),
    ...(hasAnchors ? ["keyframe completion"] : []),
    ...(hasSubjects ? ["reference generation"] : []),
  ];
  if (tasks.length) return `[${tasks.join(" + ")}]`;
  return "[text to video]";
}

/** Where each anchor frame sits in the reference list, per FR-3. */
function anchorLines(parts: H3ReferencePromptParts): string[] {
  const lines: string[] = [];
  const shows = (text: string | undefined) => {
    const summary = summariseFrame(text);
    return summary ? `, showing ${summary[0]!.toLowerCase()}${summary.slice(1)}` : "";
  };

  if (parts.hasStart) {
    lines.push(`<Picture 1> is the first frame of [Shot 1]${shows(parts.startFrameDescription)}.`);
  }
  if (parts.hasEnd) {
    lines.push(
      `<Picture ${parts.hasStart ? 2 : 1}> is the last frame of [Shot 1]` +
        `${shows(parts.endFrameDescription)}.`,
    );
  }
  return lines;
}

/** The picture number an anchor occupies, or null when it was not supplied. */
function anchorRefs(hasStart: boolean, hasEnd: boolean) {
  return {
    start: hasStart ? "<Picture 1>" : null,
    end: hasEnd ? `<Picture ${hasStart ? 2 : 1}>` : null,
  };
}

function subjectLine(subject: H3ReferenceSubject, index: number): string {
  const described = tidy(subject.description);
  const detail = described ? ` ${described}` : "";
  return (
    `<Subject ${index + 1}> is ${tidy(subject.name)}, shown in ` +
    `<Picture ${subject.pictureIndex}>, which defines their facial structure, hair, skin tone ` +
    `and clothing.${detail}`
  );
}

/** Everything inside `<d>…</d>`, which is spoken aloud and must not be edited. */
const SPEECH = /<d>[\s\S]*?<\/d>/g;

/**
 * Where the scene's own description ends and the appended clauses begin.
 *
 * Those clauses talk *about* the character rather than showing them, so a tag
 * lands badly in all of them and dangerously in one: "the frame is free of …
 * Athletic/muscular Mara" became "free of … `<Subject 1>`", which reads as an
 * instruction to leave the subject out of the shot.
 */
const APPENDED_CLAUSES = [
  " The start frame fixes how ",
  " Character continuity — ",
  " The frame is free of ",
];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Put the subject tag where the prose names the character.
 *
 * The writing agent describes a scene and calls people by name; it has no idea
 * a photograph is being supplied for one of them. Left alone, the reference has
 * nothing tying it to anyone in the shot, and the likeness lands wherever it
 * likes — a run that referenced a face without binding it put copies of that
 * head on several people around a table.
 *
 * Speech is stepped over: a name inside `<d>` is said out loud, and a spoken
 * line reading "Subject 1" would be exactly as wrong as it sounds.
 */
function bindSubjects(body: string, subjects: readonly H3ReferenceSubject[]): string {
  if (!subjects.length) return body;

  const cut = APPENDED_CLAUSES.map((marker) => body.indexOf(marker))
    .filter((at) => at >= 0)
    .reduce((lowest, at) => Math.min(lowest, at), body.length);
  const head = body.slice(0, cut);
  const tail = body.slice(cut);

  const spoken: string[] = [];
  const masked = head.replace(SPEECH, (match) => {
    spoken.push(match);
    return `\u0000${spoken.length - 1}\u0000`;
  });

  const bound = subjects.reduce((text, subject, index) => {
    const name = tidy(subject.name);
    if (!name) return text;
    return text.replace(
      new RegExp(`\\b${escapeForRegExp(name)}\\b`, "g"),
      `<Subject ${index + 1}>`,
    );
  }, masked);

  return bound.replace(/\u0000(\d+)\u0000/g, (_match, i: string) => spoken[Number(i)] ?? "") + tail;
}

/**
 * One retention line per label, with its marker.
 *
 * The guide wants this stated rather than inferred, and the two kinds of
 * reference want opposite answers: an anchor frame is reproduced, a face is
 * transferred onto a person the anchor already composed. Each anchor also names
 * *when* it applies, because "preserved" alone does not say at which end.
 */
function retentionLines(
  hasStart: boolean,
  hasEnd: boolean,
  subjects: readonly H3ReferenceSubject[],
  hasVideoSource: boolean,
): string[] {
  const { start, end } = anchorRefs(hasStart, hasEnd);
  const lines: string[] = [];

  if (hasVideoSource) {
    lines.push(
      "<Video 1> (continues into [Shot 1]): fully_preserved — the final visual and audio state, " +
        "subject identities, props, setting, lighting, camera trajectory and ongoing motion carry " +
        "directly into the new shot.",
    );
  }

  if (start) {
    lines.push(
      `${start} ([Shot 1] first frame): fully_preserved — the opening composition, camera ` +
        "position, set dressing and lighting are reproduced exactly at the start of the shot.",
    );
  }
  if (end) {
    lines.push(
      `${end} ([Shot 1] last frame): fully_preserved — the closing framing, subject position and ` +
        "lighting are reached exactly at the end of the shot.",
    );
  }

  subjects.forEach((subject, index) => {
    const marker = subject.retention ?? "attribute_transfer";
    lines.push(
      `<Subject ${index + 1}> (appears in [Shot 1]): ${marker} — facial identity is carried over ` +
        "with no drift across the clip; the photograph's own pose, framing, wardrobe and " +
        "background are not.",
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
  const hasVideoSource = Boolean(parts.hasVideoSource);
  const subjects = parts.subjects;
  const { start, end } = anchorRefs(parts.hasStart, parts.hasEnd);

  const definitions = [
    ...(hasVideoSource
      ? [
          "<Video 1> supplies the source clip being continued, including its final visual state, " +
            "subjects, action, camera trajectory, and synchronized audio.",
        ]
      : []),
    ...anchorLines(parts),
    ...subjects.map(subjectLine),
  ];

  // Where the anchoring actually has to be said.
  //
  // A hand-made render that came out correct states it four times over — in the
  // summary, in the retention lines, and at both ends of the description — and
  // the one place it cannot be left to the writing agent is the description,
  // because the agent is describing a scene and not a set of pictures. A build
  // that named the anchors only in the bookkeeping sections produced a clip
  // that reached its closing frame correctly and opened on something invented.
  //
  // Pose is named alongside the framing because the two can disagree: a scene
  // whose keyframe already shows a tilted head was described as beginning with
  // the subject still, and prose beats a picture the model was only told about.
  // For the same reason the frame's own description is repeated here rather
  // than left in `subject_definitions` — this sentence sits immediately before
  // the agent's prose, which is the text the opening actually gets built from.
  const openingShows = summariseFrame(parts.startFrameDescription);
  const opening = start
    ? `The shot begins from ${start}${openingShows ? ` — ${openingShows} —` : ""}, holding its ` +
      "composition, camera position, framing, lighting and the subject's exact pose in that " +
      "frame. Nothing happens before the first change described below."
    : "";
  const closing = end
    ? `The shot settles into the exact framing, subject position and lighting established by ` +
      `${end}, which is its final frame.`
    : "";
  const continuedOpening = hasVideoSource
    ? "The shot begins immediately after <Video 1>'s final frame, with no visual, motion, camera, " +
      "or audio reset, and the first described action continues from that exact state."
    : "";

  const body = bindSubjects(markDialogue(tidy(parts.body)), subjects).replace(
    /^\[Shot 1\]\s*/,
    "",
  );
  const style = tidy(parts.style);
  const timeline = [SHOT, continuedOpening, opening, body, closing].filter(Boolean).join(" ");

  const journey =
    hasVideoSource
      ? "The target video continues directly from <Video 1>."
      : start && end
      ? `The target video is a single continuous shot that begins from ${start} and ends on ${end}.`
      : "The target video is a single continuous shot.";

  const values: Record<(typeof SECTIONS)[number], string> = {
    subject_definitions: definitions.join("\n") || "N/A",
    summary: `${h3ReferenceTaskType(hasAnchors, subjects.length > 0, hasVideoSource)} ${journey} ${
      tidy(parts.summary)
    }`.trim(),
    retention_analysis:
      retentionLines(parts.hasStart, parts.hasEnd, subjects, hasVideoSource).join("\n") || "N/A",
    detailed_description: style ? `${style}\n${timeline}` : timeline,
    overall_soundscape: tidy(parts.soundscape) || "N/A",
    non_diegetic_music: tidy(parts.score) || "N/A",
  };

  // Label on its own line, matching the layout of the render that worked.
  return SECTIONS.map((section) => `${section}:\n${values[section]}`).join("\n");
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
    dropReferenceSentences(section("detailed_description")),
    section("overall_soundscape"),
    section("non_diegetic_music"),
  ]
    .filter((value) => value && value !== "N/A")
    .map(stripDialogueMarkup)
    .join(" ")
    .trim();
}

/**
 * Remove the sentences that only make sense while references are attached.
 *
 * The anchoring assertions name pictures by number. Handed to a model that is
 * not being sent them, they are instructions about images that do not exist,
 * which is worse than losing them.
 */
function dropReferenceSentences(text: string): string {
  return text
    .replace(/\[Shot 1\]\s*/g, "")
    // Also break after a closing dialogue tag: a spoken line ends `go.</d>`,
    // with no space before the period, so splitting on sentences alone leaves
    // the speech joined to whatever follows — and it was being discarded along
    // with the reference sentence it had been glued to.
    .split(/(?<=\.|<\/d>)\s+/)
    // Only the picture sentences go. A subject tag names someone the scene is
    // about, so the sentence is worth keeping even though the tag is not — the
    // name it stood in for is not recoverable here, and "the character" reads
    // better than dropping the action they perform.
    .filter((sentence) => !/<Picture\s*\d*>/i.test(sentence))
    .join(" ")
    .replace(/<Subject\s*\d*>/gi, "the character")
    .replace(/<Video\s*\d*>/gi, "the source video")
    .replace(/(^|[.!?]\s+)the character/g, (_match, lead: string) => `${lead}The character`)
    .trim();
}

/** Only the reference variant takes this format — FL2VA has its own. */
export function usesH3ReferenceFormat(family: ModelFamily): boolean {
  return family === "minimax_ref2va";
}
