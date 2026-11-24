import {
  markSceneDialogue,
  stripDialogueMarkup,
  withoutBlankLines,
  type ExtraSpeech,
  type SceneLine,
} from "@/lib/agents/h3-prompt";
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
   * Further pictures of the *same* character, when more than one was sent.
   *
   * Named separately rather than merged into one range because the format
   * addresses pictures individually, and the model has to be told these are
   * more views of one person — otherwise a second photograph of a character
   * reads as a second character.
   */
  additionalPictureIndices?: number[];
  /**
   * How much of the reference the model should carry over. The guide's four
   * markers; identity work wants `attribute_transfer`, which takes the face
   * without the photograph's pose, framing or clothing.
   */
  retention?: H3Retention;
  /**
   * 1-based `<Audio N>` this character's voice recording occupies, when one is
   * sent. Numbered independently of pictures, as the guide requires.
   */
  audioIndex?: number;
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
  /** The scene's dialogue: tags every line it contains and says who speaks each. */
  dialogue?: readonly SceneLine[];
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

/** Text StoryForge appends to a keyframe prompt for the image model, from where it starts. */
const FRAME_APPENDIX = [
  " Character continuity — ",
  " Wardrobe continuity — ",
  " Render with ",
  " The frame is free of ",
];

/** A leading clause that only places the camera: shot size, height, angle, lens or move. */
const CAMERA_CLAUSE = new RegExp(
  "^(?:" +
    [
      "(?:extreme\\s+)?(?:wide|full|medium(?:[\\s-]+(?:wide|close[\\s-]*up))?|close[\\s-]*up|cowboy|establishing|two)(?:\\s+shot)?",
      "(?:ews|ws|fs|mws|ms|mcu|cu|ecu)",
      "eye[\\s-]level\\b.*",
      "(?:low|high|overhead|dutch|bird'?s[\\s-]eye|worm'?s[\\s-]eye|top[\\s-]down)(?:[\\s-]+angle)?\\b.*",
      "(?:\\d+\\s?mm|[a-z-]+\\s+millimet(?:er|re))(?:\\s+(?:lens|prime))?\\b.*",
      "(?:static|handheld|locked[\\s-]off|tracking|dolly|crane|slow\\s+push[\\s-]in)\\b.*",
      "(?:slight\\s+)?(?:downward|upward)\\s+tilt\\b.*",
      "from\\s+(?:behind|above|below|the\\s+(?:left|right|side|front|rear))\\b.*",
      "over[\\s-]the[\\s-]shoulder\\b.*",
      "(?:front|profile|three[\\s-]quarter(?:\\s+rear)?|rear)(?:\\s+(?:view|angle))?",
    ].join("|") +
    ")$",
  "i",
);

/** Sentences written for the image model rather than describing what is in the picture. */
function directsTheImageModel(sentence: string): boolean {
  const text = sentence.trim();
  return (
    /^intended audience:/i.test(text) ||
    /^exactly\s+\w+\s+(?:people|persons?)\s+(?:is|are)\s+in\s+(?:the\s+)?frame\b/i.test(text) ||
    // The look suffix: "<style> style, <tone> mood." It starts in lower case,
    // because it is the project's style value verbatim, or pairs the two words.
    (/\b(?:style|mood)\.?$/i.test(text) &&
      text.split(/\s+/).length <= 14 &&
      (/^\p{Ll}/u.test(text) || /\bstyle,\s[^,]+\smood\.?$/i.test(text)))
  );
}

/**
 * What a keyframe shows, as a picture rather than as instructions for drawing it.
 *
 * A keyframe prompt is written for an image model, so StoryForge appends the
 * project's style and tone, the intended audience, the cast sheet and the
 * wardrobe to it, and the writing agent opens it with shot size, angle and lens
 * and states a headcount. Pasted into the H3 prompt to say what an anchor
 * picture contains, that text sat at the very start of the timeline — and with
 * a voice reference attached H3 read it aloud: "erotic art film style, raw and
 * carnal mood. Intended audience: adults only, explicit content" spoken over the
 * first eight seconds of a clip whose line came at the end. The picture itself
 * already carries the framing and the look; only its contents are worth saying.
 */
export function visibleFrameContent(prompt: string | undefined): string {
  let text = tidy(prompt);
  const cut = FRAME_APPENDIX.map((marker) => ` ${text}`.indexOf(marker))
    .filter((at) => at >= 0)
    .reduce((lowest, at) => Math.min(lowest, at), Number.POSITIVE_INFINITY);
  if (Number.isFinite(cut)) text = text.slice(0, Math.max(0, cut - 1)).trim();

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const [first, ...rest] = sentences;
  const opening = first ? withoutCameraOpening(first) : "";
  return [opening, ...rest]
    .map((sentence) => sentence.replace(/^Setting:\s*/i, ""))
    .filter((sentence) => sentence && !directsTheImageModel(sentence))
    .map((sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1))
    .join(" ")
    .trim();
}

/**
 * Drop the camera placement a keyframe prompt opens with, keeping anything in
 * the same sentence that describes the shot's contents: "Wide shot, eye level,
 * a woman stands at a window" keeps "a woman stands at a window", and
 * "Full shot, eye level, 50mm: Mara walks…" keeps "Mara walks…".
 */
function withoutCameraOpening(sentence: string): string {
  const colon = sentence.indexOf(":");
  if (colon > 0) {
    const lead = sentence.slice(0, colon).split(",").map((clause) => clause.trim());
    if (lead.length && lead.every((clause) => CAMERA_CLAUSE.test(clause))) {
      return sentence.slice(colon + 1).trim();
    }
  }
  const clauses = sentence.replace(/[.!?]+$/, "").split(",").map((clause) => clause.trim());
  let kept = 0;
  while (kept < clauses.length && CAMERA_CLAUSE.test(clauses[kept]!)) kept += 1;
  if (kept === 0) return sentence;
  if (kept === clauses.length) return "";
  return `${clauses.slice(kept).join(", ")}${/[.!?]$/.test(sentence) ? sentence.slice(-1) : "."}`;
}

const SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

const SHOT = "[Shot 1]";

/** The guide keeps the two audio fields on the label's own line. */
const INLINE_SECTIONS = new Set<(typeof SECTIONS)[number]>([
  "overall_soundscape",
  "non_diegetic_music",
]);

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
  hasVoices = false,
): string {
  const tasks = [
    ...(hasVideoSource ? ["video continuation"] : []),
    ...(hasAnchors ? ["keyframe completion"] : []),
    ...(hasSubjects ? ["reference generation"] : []),
    ...(hasVoices ? ["audio reference"] : []),
  ];
  if (tasks.length) return `[${tasks.join(" + ")}]`;
  return "[text to video]";
}

/** Where each anchor frame sits in WanGP's picture order; see `h3LeadingPictures`. */
function anchorLines(parts: H3ReferencePromptParts): string[] {
  const lines: string[] = [];
  const shows = (text: string | undefined) => {
    const summary = summariseFrame(text);
    return summary ? `, showing ${summary[0]!.toLowerCase()}${summary.slice(1)}` : "";
  };
  const { start, continued, end } = anchorRefs(parts.hasStart, parts.hasEnd, Boolean(parts.hasVideoSource));

  if (start) {
    lines.push(`${start} is the first frame of [Shot 1]${shows(parts.startFrameDescription)}.`);
  }
  // WanGP presents the frame a continuation picks up from as a picture of its
  // own, ahead of the end frame. Left unnamed it was an unexplained image, and
  // the end frame was being called by its number.
  if (continued) {
    lines.push(`${continued} is the final frame of <Video 1>, the frame [Shot 1] begins from.`);
  }
  if (end) {
    lines.push(`${end} is the last frame of [Shot 1]${shows(parts.endFrameDescription)}.`);
  }
  return lines;
}

/**
 * How many pictures WanGP's H3 pipeline presents before the first reference
 * image: the start frame or the frame a continuation picks up from, then the
 * end frame. The same whether the frames are native inputs or sent inside
 * `image_refs` — its handler documents the order as "start or continued frame
 * (<Picture 1>), end image, … then references".
 */
export function h3LeadingPictures(hasStart: boolean, hasEnd: boolean, hasVideoSource: boolean): number {
  return (hasStart || hasVideoSource ? 1 : 0) + (hasEnd ? 1 : 0);
}

/** The picture number each anchor occupies, or null when it was not supplied. */
function anchorRefs(hasStart: boolean, hasEnd: boolean, hasVideoSource = false) {
  const opens = hasStart || hasVideoSource;
  return {
    start: hasStart ? "<Picture 1>" : null,
    continued: hasVideoSource && !hasStart ? "<Picture 1>" : null,
    end: hasEnd ? `<Picture ${opens ? 2 : 1}>` : null,
  };
}

/**
 * How this character's pictures are named in the subject definition.
 *
 * Several pictures of one person have to be declared as such. Listed
 * individually and said to be the same person, because the format addresses
 * pictures by number and an unexplained second photograph of a character reads
 * as a second character — the failure that keeps one likeness from landing on
 * two bodies is always an explicit binding, never proximity.
 */
function pictureClause(subject: H3ReferenceSubject): string {
  const extra = subject.additionalPictureIndices ?? [];
  if (!extra.length) return `<Picture ${subject.pictureIndex}>,`;
  const all = [subject.pictureIndex, ...extra].map((index) => `<Picture ${index}>`);
  const last = all.pop()!;
  return `${all.join(", ")} and ${last}, which are the same person from different angles,`;
}

function subjectLine(subject: H3ReferenceSubject, index: number, hasEstablishedFrame: boolean): string {
  const described = tidy(subject.description);
  const detail = hasEstablishedFrame
    ? " Pose and clothing follow the frame anchors or continued video."
    : described ? ` ${described}` : "";
  return (
    `<Subject ${index + 1}> is ${tidy(subject.name)}, shown in ` +
    `${pictureClause(subject)} which defines their facial identity.${detail}`
  );
}

/**
 * Bind a voice recording to the subject who speaks with it.
 *
 * Stated as identity only. The guide's wording for a reference — as opposed to
 * copied audio — reuses the timbre and delivery and generates the words anew,
 * which is what keeps the storyboard's lines, rather than the sample's, coming
 * out of the character's mouth.
 */
function voiceLine(subject: H3ReferenceSubject, index: number): string | null {
  if (!subject.audioIndex) return null;
  const who = `<Subject ${index + 1}>`;
  // Wan2GP's own voice-clone wording. A further sentence telling the subject to
  // say nothing else was itself read aloud, so the restriction lives in the
  // summary and the soundscape instead.
  return (
    `<Audio ${subject.audioIndex}> supplies the voice timbre, accent, cadence and delivery identity ` +
    `for ${who}; its words, timing and background noise are not copied.`
  );
}

/** The phrase that ties one spoken line to its voice recording. */
export function voiceClause(audioIndex: number): string {
  return `in the voice from <Audio ${audioIndex}>`;
}

/**
 * Say, at each line a voiced subject speaks, which recording it is spoken in.
 *
 * Each `<d>` is attributed by its words, against the scene's dialogue, so a line
 * introduced as "she speaks" or "his voice carries" is found as surely as one
 * introduced with the speaker's name. Without dialogue, the subject tag in the
 * same sentence with nothing between it and the speech decides, and an unnamed
 * "a voice says" is left alone.
 *
 * The clause goes ahead of the speaker id and the colon introducing the speech,
 * outside `<d>`, so it is direction and never words to be said.
 */
function voiceSpokenLines(
  body: string,
  subjects: readonly H3ReferenceSubject[],
  speakers: readonly (string | undefined)[],
  hasDialogue: boolean,
): { body: string; voiced: Set<number> } {
  const voiced = new Set<number>();
  const tags = [...body.matchAll(/<d>[\s\S]*?<\/d>/g)];
  let text = body;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const open = tags[i]!.index!;
    const owner = speakers[i]?.trim().toLocaleLowerCase();
    let index = owner
      ? subjects.findIndex((subject) => tidy(subject.name).toLocaleLowerCase() === owner)
      : -1;
    // Proximity only when there is no dialogue to ask. With dialogue, a tagged
    // line it does not have belongs to nobody known: "Gripping Tracey's hips,
    // Leroy says, …" put Tracey's voice on Leroy's line.
    if (index < 0 && owner === undefined && !hasDialogue) {
      const near = /<Subject (\d+)>[^<]*$/.exec(sentenceUpTo(text, open));
      index = near ? Number(near[1]) - 1 : -1;
    }
    const audioIndex = subjects[index]?.audioIndex;
    if (!audioIndex) continue;

    let at = open;
    const id = /\(S\d+\)\s*$/.exec(text.slice(0, at));
    if (id) at = id.index;
    at = /\s*[:,]?\s*$/.exec(text.slice(0, at))!.index;
    text = `${text.slice(0, at)} ${voiceClause(audioIndex)}${text.slice(at)}`;
    voiced.add(index);
  }
  return { body: text, voiced };
}

function sentenceUpTo(text: string, offset: number): string {
  const before = text.slice(0, offset);
  let start = 0;
  for (const match of before.matchAll(/[.!?]["”']?\s+|<\/d>/g)) start = match.index! + match[0].length;
  return before.slice(start);
}

/**
 * The timeline prose with speech tagged, subjects bound and voices attached,
 * plus what could not be attached.
 */
function timelineBody(parts: H3ReferencePromptParts) {
  const voiced = parts.subjects.some((subject) => subject.audioIndex);
  const source = voiced ? withoutInstructions(tidy(parts.body)) : tidy(parts.body);
  const marking = markSceneDialogue(
    source,
    parts.dialogue,
    parts.subjects.map((subject) => subject.name),
  );
  const { body, voiced: bound } = voiceSpokenLines(
    bindSubjects(marking.text, parts.subjects),
    parts.subjects,
    marking.speakers,
    parts.dialogue !== undefined,
  );
  return {
    body: voiced ? closeDialogue(body) : body,
    voiced: bound,
    unmatched: marking.unmatched,
    extras: marking.extras,
  };
}

/**
 * Sentences in a clip prompt that instruct rather than show.
 *
 * Each is added for a reason — identity continuity, an exclusion folded into
 * positive text because H3 has no negative prompt, a request for lip sync —
 * but none describes anything to see or hear, and with a voice reference
 * attached H3 voiced such sentences in the character's voice. Removed only for
 * voiced clips: there the photograph already holds identity, and the risk of a
 * line of instructions being spoken outweighs what they add.
 */
const INSTRUCTION_SENTENCES = [
  /^Lip movement matches the spoken words\.?$/i,
  /^The start frame fixes how\b[^.]*\.?$/i,
  /^Keep (?:face|faces)\b[^.]*\bunchanged\b[^.]*\.?$/i,
  /^Render with\b[^.]*\.?$/i,
  /^The frame is free of\b[^.]*\.?$/i,
];

function withoutInstructions(text: string): string {
  const cut = text.indexOf(" Character continuity — ");
  const kept = (cut >= 0 ? text.slice(0, cut) : text)
    .replace(/,?\s*evolving from the start frame to the end frame over [\d.]+ seconds/gi, "")
    // The phrase can follow a full stop the prompt already had ("matters.,").
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .split(/(?<=[.!?]["”’']?)\s+/)
    .filter((sentence) => !INSTRUCTION_SENTENCES.some((pattern) => pattern.test(sentence.trim())));
  return kept.join(" ").trim();
}

/** Wan2GP's own close to a voice-cloned line, after the last spoken line. */
export const DIALOGUE_COMPLETE = "The dialogue is complete and no other words are spoken.";

function closeDialogue(body: string): string {
  const last = body.lastIndexOf("</d>");
  if (last < 0) return body;
  const at = last + "</d>".length;
  return `${body.slice(0, at)} ${DIALOGUE_COMPLETE}${body.slice(at)}`;
}

/** Why a voiced subject's recording cannot safely be sent. */
export type VoiceProblem = {
  name: string;
  /**
   * `line_not_tagged`: one of their lines never reached the prompt as tagged
   * speech. `unscripted_speech`: the prompt quotes speech the dialogue does not
   * have, either theirs or nobody's in particular, which H3 could improvise in
   * their voice.
   */
  reason: "line_not_tagged" | "unscripted_speech";
};

/**
 * The voiced subjects whose recording cannot safely be sent.
 *
 * A recording is only safe when every line its speaker has in the scene
 * reached the prompt as tagged speech carrying the voice clause, and no speech
 * the dialogue lacks — tagged or not — sits where it could be theirs. Anything
 * less hands H3 a voice with words it is free to make up — the failure that had
 * a character reading her scene's description aloud. Unscripted speech whose
 * sentence names nobody, or several people, could be anyone's, so it stops
 * every voice. With no dialogue to check against, at least one bound line is
 * required.
 */
export function voiceProblems(parts: H3ReferencePromptParts): VoiceProblem[] {
  const { voiced, unmatched, extras } = timelineBody(parts);
  const problems: VoiceProblem[] = [];
  parts.subjects.forEach((subject, index) => {
    if (!subject.audioIndex) return;
    const name = tidy(subject.name).toLocaleLowerCase();
    const same = (other: string | undefined) => other?.trim().toLocaleLowerCase() === name;
    if (unmatched.some((entry) => same(entry.character)) || !voiced.has(index)) {
      problems.push({ name: subject.name, reason: "line_not_tagged" });
    } else if (extras.some((extra) => extra.speaker === undefined || same(extra.speaker))) {
      problems.push({ name: subject.name, reason: "unscripted_speech" });
    }
  });
  return problems;
}

/** The voiced subjects whose recording cannot safely be sent — see `voiceProblems`. */
export function unvoicedSubjects(parts: H3ReferencePromptParts): string[] {
  return voiceProblems(parts).map((problem) => problem.name);
}

/** Speech the prompt quotes that the scene's dialogue does not have. */
export function unscriptedSpeech(parts: H3ReferencePromptParts): ExtraSpeech[] {
  return timelineBody(parts).extras;
}

/**
 * Everything spoken, which must not be edited: tagged speech, and any quotation
 * left untagged. A name inside a quotation is who is being spoken to as often
 * as not — "faster, Tracey" is someone else's line — and a tag there would be
 * read out, or bind her face to the wrong speaker.
 */
const SPEECH = /<d>[\s\S]*?<\/d>|["“][^"“”\n]+["”]/g;

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
  const { start, end } = anchorRefs(hasStart, hasEnd, hasVideoSource);
  const lines: string[] = [];

  if (hasVideoSource) {
    lines.push(
      "<Video 1> (continues into [Shot 1]): fully_preserved - the final visual and audio state, " +
        "subject identities, props, setting, lighting, camera trajectory and ongoing motion carry " +
        "directly into the new shot.",
    );
  }

  if (start) {
    lines.push(
      `${start} ([Shot 1] first frame): fully_preserved - the opening composition, camera ` +
        "position, set dressing and lighting are reproduced exactly at the start of the shot.",
    );
  }
  if (end) {
    lines.push(
      `${end} ([Shot 1] last frame): fully_preserved - the closing framing, subject position and ` +
        "lighting are reached exactly at the end of the shot.",
    );
  }

  subjects.forEach((subject, index) => {
    const marker = subject.retention ?? "attribute_transfer";
    lines.push(
      `<Subject ${index + 1}> (appears in [Shot 1]): ${marker} - facial identity is carried over ` +
        "with no drift across the clip; the photograph's own pose, framing, wardrobe and " +
        "background are not.",
    );
  });

  // Audio has its own retention vocabulary; `reference` is the guide's word for
  // a voice that is reused but not copied.
  subjects.forEach((subject, index) => {
    if (!subject.audioIndex) return;
    lines.push(
      `<Audio ${subject.audioIndex}> (heard in [Shot 1]): reference - retain only the stable vocal ` +
        `identity of <Subject ${index + 1}>; generate the requested words and performance anew.`,
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
export function renderH3ReferencePrompt(input: H3ReferencePromptParts): string {
  // The anchors are described by their contents alone; see `visibleFrameContent`.
  const parts: H3ReferencePromptParts = {
    ...input,
    startFrameDescription: visibleFrameContent(input.startFrameDescription) || undefined,
    endFrameDescription: visibleFrameContent(input.endFrameDescription) || undefined,
  };
  const hasAnchors = parts.hasStart || parts.hasEnd;
  const hasVideoSource = Boolean(parts.hasVideoSource);
  const subjects = parts.subjects;
  const { start, end } = anchorRefs(parts.hasStart, parts.hasEnd, hasVideoSource);

  const definitions = [
    ...(hasVideoSource
      ? [
          "<Video 1> supplies the source clip being continued, including its final visual state, " +
            "subjects, action, camera trajectory, and synchronized audio.",
        ]
      : []),
    ...anchorLines(parts),
    ...subjects.flatMap((subject, index) => {
      const voice = voiceLine(subject, index);
      return [subjectLine(subject, index, hasAnchors || hasVideoSource), ...(voice ? [voice] : [])];
    }),
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
  // With a voice attached H3 reads sentences that show nothing aloud, and this
  // one was heard in two clips running ("the first change they described…").
  const voiced = subjects.some((subject) => subject.audioIndex);
  const opening = start
    ? `The shot begins from ${start}${openingShows ? ` — ${openingShows} —` : ""}, holding its ` +
      "composition, camera position, framing, lighting and the subject's exact pose in that " +
      `frame.${voiced ? "" : " Nothing happens before the first change described below."}`
    : "";
  const closing = end
    ? `The shot settles into the exact framing, subject position and lighting established by ` +
      `${end}, which is its final frame.`
    : "";
  const continuedOpening = hasVideoSource
    ? "The shot begins immediately after <Video 1>'s final frame, with no visual, motion, camera, " +
      "or audio reset, and the first described action continues from that exact state."
    : "";

  const body = timelineBody(parts).body.replace(/^\[Shot 1\]\s*/, "");
  const style = tidy(parts.style);
  // The guide opens `detailed_description` with a whole-video statement ahead of
  // the first shot marker; the anchors are asserted in the sentences after it.
  const overview = hasVideoSource
    ? "The target video is a single continuous shot that continues directly from <Video 1>."
    : "The target video is a single continuous shot.";
  const timeline = [overview, style, SHOT, continuedOpening, opening, body, closing]
    .filter(Boolean)
    .join(" ");

  const journey =
    hasVideoSource
      ? "The target video continues directly from <Video 1>."
      : start && end
      ? `The target video is a single continuous shot that begins from ${start} and ends on ${end}.`
      : "The target video is a single continuous shot.";

  const values: Record<(typeof SECTIONS)[number], string> = {
    subject_definitions: definitions.join("\n") || "N/A",
    summary: `${h3ReferenceTaskType(
      hasAnchors,
      subjects.length > 0,
      hasVideoSource,
      voiced,
    )} ${journey} ${[tidy(parts.summary), voiced ? SPEECH_LIMIT : ""].filter(Boolean).join(" ")}`.trim(),
    retention_analysis:
      retentionLines(parts.hasStart, parts.hasEnd, subjects, hasVideoSource).join("\n") || "N/A",
    detailed_description: timeline,
    overall_soundscape: soundscapeWithVoices(parts.soundscape, subjects),
    non_diegetic_music: tidy(parts.score) || "N/A",
  };

  // A blank line anywhere would make Wan2GP start a second video, so the whole
  // prompt is normalised rather than trusting every value to be single-spaced.
  return withoutBlankLines(
    SECTIONS.map((section) =>
      INLINE_SECTIONS.has(section)
        ? `${section}: ${values[section]}`
        : `${section}:\n${values[section]}`,
    ).join("\n"),
  );
}

/** Whether a prompt is already in this format. */
export function isH3ReferencePrompt(prompt: string): boolean {
  return prompt.includes("subject_definitions:");
}

/** Closes the soundscape whenever a voice recording is sent. */
export const NO_OTHER_SPEECH =
  "No speech other than the marked lines; between them, only the ambience described.";

/**
 * The summary's statement of what is spoken, after Wan2GP's voice-clone prompt
 * ("…with no extra words before or after it"). The summary states the task,
 * which is where a restriction is read as one rather than as words to say.
 */
export const SPEECH_LIMIT = "Only the marked lines are spoken, with no extra words before or after them.";

/**
 * The soundscape, closed against invented speech when a voice is sent.
 *
 * A twenty-second clip carrying four seconds of dialogue leaves H3 sixteen
 * seconds to fill, and holding a voice it filled them with speech. Said in the
 * section that owns the soundtrack, so the silence between lines is something
 * it was asked for rather than a gap.
 */
function soundscapeWithVoices(soundscape: string | undefined, subjects: readonly H3ReferenceSubject[]): string {
  const described = tidy(soundscape);
  if (!subjects.some((subject) => subject.audioIndex)) return described || "N/A";
  if (!described) return NO_OTHER_SPEECH;
  return `${described.replace(/[.\s]*$/, ".")} ${NO_OTHER_SPEECH}`;
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
    // Reads either layout, so a prompt stored under one setting still strips
    // cleanly under the other.
    const pattern = new RegExp(
      `${name}:\\s*([\\s\\S]*?)(?=\\s*(?:${SECTIONS.join("|")}):|$)`,
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
    // A voice clause names a recording the fallback model is not being sent.
    .replace(/\s*in the voice from <Audio\s*\d*>/gi, "")
    .replace(/<Subject\s*\d*>/gi, "the character")
    .replace(/<Video\s*\d*>/gi, "the source video")
    .replace(/(^|[.!?]\s+)the character/g, (_match, lead: string) => `${lead}The character`)
    .trim();
}

/** Only the reference variant takes this format — FL2VA has its own. */
export function usesH3ReferenceFormat(family: ModelFamily): boolean {
  return family === "minimax_ref2va";
}
