import type { ModelFamily } from "@/lib/wangp/family";

/**
 * Wan2GP starts a new video at every blank line in a prompt, so one anywhere in
 * an H3 prompt splits the scene into separate generations. Single breaks are
 * safe and wanted — the labelled fields are meant to sit on their own lines.
 */
export function withoutBlankLines(prompt: string): string {
  return prompt.replace(/[ \t]*\r?\n(?:[ \t]*\r?\n)+/g, "\n").trim();
}

/**
 * MiniMax H3's native prompt envelope.
 *
 * H3 does not take one blob of prose. Its published guide
 * (VIDEO_PROMPT_WRITING_GUIDE_base_en) specifies an optional alignment
 * instruction followed by three labelled fields: the timeline, the ambience,
 * and the audience-only score. WanGP passes `prompt` through
 * untouched and `prompt_enhancer` is forced off, so nothing between StoryForge
 * and the model will produce this shape if we do not.
 *
 * **Off by default, but the earlier verdict against it was wrong.** Three A/B
 * pairs on `minimax_h3_fl2va_pruned` at 20 steps produced no spoken dialogue in
 * the enveloped arm while plain prose spoke the line every time, and that was
 * recorded here as the envelope suppressing speech. It is not.
 *
 * The test scene was a robot, and because H3 declares no `negative_prompt` its
 * exclusions are folded into positive text — so the prompt stated the subject
 * had no mouth, and then asked it to speak. Running the same enveloped prompt
 * with the 4-step turbo accelerator produced speech *and* a moving mouth, and
 * so did 8 steps. Every result sits on one axis: the envelope makes the model
 * follow instructions more literally, distillation makes it follow them less.
 * At 20 steps the envelope honoured the visual constraint and stayed silent;
 * the accelerator overrode it. The same looseness scattered a referenced face
 * onto several people in a Ref2VA run, so it is not a virtue — just a
 * different trade.
 *
 * The envelope was therefore obeying a contradiction we authored, not failing.
 * Silence is confined to one cell — envelope at full step count — and doubling
 * the accelerator's steps did not begin to recover it, so nothing on the
 * shipping fast path will hit it. What remains untested is the case that would
 * settle it: an enveloped prompt at full step count on a character whose
 * description does not forbid the thing being asked of them.
 *
 * H3 is three modules: a hosted **H3-Context-IR** that turns free-form input
 * into exactly this structure, **H3-Base** (what WanGP runs) which consumes it,
 * and a hosted 2K regenerator. MiniMax's own worked examples post this
 * structure to a locally deployed H3-Base, so it is the documented input here.
 *
 * Also eliminated along the way, and still worth not repeating:
 *   - *Audio direction.* The first pair differed because only the enveloped arm
 *     carried ambience and score; both have carried it since.
 *   - *Tokenisation.* WanGP ships MiniMax's tokenizer config, and
 *     `Qwen3-VL-32B-Instruct` declares `<d>` and `</d>` as special tokens.
 *   - *Prompt length.* Raising the timeline from ~120 to ~294 words changed
 *     nothing.
 *
 * Everything here is pure string work over facts the caller already has, so the
 * format can be verified without a GPU.
 */

/** Which of H3's modes a set of supplied keyframes puts the job in. */
export type H3Mode = "t2va" | "i2va" | "l2va" | "fl2va";

export function h3Mode(hasStart: boolean, hasEnd: boolean): H3Mode {
  if (hasStart && hasEnd) return "fl2va";
  if (hasStart) return "i2va";
  if (hasEnd) return "l2va";
  return "t2va";
}

/** The guide formats every timestamp to exactly two decimal places. */
function seconds(value: number): string {
  return Math.max(0, value).toFixed(2);
}

/**
 * The first line, which tells H3 where each supplied frame lands in time.
 *
 * The wording is fixed by the guide rather than chosen — each mode has one
 * sentence, quoted verbatim there. T2VA has no instruction at all.
 */
export function h3AlignmentHeader(mode: H3Mode, durationSeconds: number): string {
  if (mode === "i2va") {
    return (
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) " +
      "is fully referenced."
    );
  }
  if (mode === "l2va") {
    return (
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) " +
      `aligns with the ${seconds(durationSeconds)}-second mark of the target video.`
    );
  }
  if (mode === "fl2va") {
    return (
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) " +
      "aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 1]) aligns with the " +
      `${seconds(durationSeconds)}-second mark of the target video.`
    );
  }
  return "";
}

export type H3PromptParts = {
  /** The timeline prose, without the `[Shot 1]` marker. */
  body: string;
  /** Ambience and physical sound. Empty falls back to the guide's `N/A`. */
  soundscape?: string;
  /** Audience-only score. Empty means there is none, which the guide writes `N/A`. */
  score?: string;
  durationSeconds: number;
  hasStart: boolean;
  hasEnd: boolean;
  /** A source clip supplied through Wan2GP's continuation input. */
  hasVideoSource?: boolean;
  /** The scene's dialogue, so every line it contains is tagged as speech. */
  dialogue?: readonly SceneLine[];
};

/** Trailing whitespace and a single trailing period, normalised. */
function tidy(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

const SHOT = "[Shot 1]";

/** Speech markup: `<d>[Language] words</d>`, per the guide. */
const DIALOGUE_TAG = /<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/g;

/**
 * A said/says clause with the spoken words quoted after it.
 *
 * The delivery usually sits between the two — `says in a low, gravelly voice,
 * "…"` — so a clause of up to a line is allowed there, provided it ends in the
 * comma or colon that introduces the quote. Requiring the quote immediately
 * after the verb left real dialogue untagged, and an untagged line inside this
 * format is description: the model shows someone speaking and says nothing.
 */
const SPOKEN_CLAUSE =
  /(?:\b(\p{Lu}[\p{L}'’-]*)\s+)?\b(says?|said)\b([^"“”\n]{0,80}?)[,:]?\s*["“]([^"”]+)["”]/gu;

/**
 * Tag spoken lines so H3 performs them instead of describing them.
 *
 * Inside the envelope a quoted sentence is just more description: a live clip
 * whose prompt said `The robot says, "..."` came back with no speech in it at
 * all, while the same line in loose prose was at least sung. The guide is
 * explicit that only `<d>` content is uttered, and that the speaker id and
 * delivery stay outside the tag.
 *
 * Left alone when the prompt already carries markup, so a prompt written to the
 * contract is never rewritten by a regex.
 *
 * Pass the scene's dialogue to tag every line it contains, whatever verb the
 * prose introduces it with — see `markSceneDialogue`.
 */
export function markDialogue(text: string, lines?: readonly SceneLine[]): string {
  return markSceneDialogue(text, lines).text;
}

/** One line of a scene's dialogue: who says it and the exact words. */
export type SceneLine = { character: string; line: string };

/**
 * Whether a dialogue line has words to say once its stage directions are
 * removed. "(Nods)" and "(Heavy breathing)" are direction written in the
 * dialogue list: no prompt can quote them as speech, so treating them as lines
 * would leave a voiced character permanently "missing" a line.
 */
export function isSpokenLine(line: string): boolean {
  return Boolean(normaliseSpeech(line.replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, " ")));
}

export type DialogueMarking = {
  text: string;
  /** Who says each `<d>` in `text`, in order; undefined where it is not a scene line. */
  speakers: (string | undefined)[];
  /** Scene lines with no `<d>` attributed to them. */
  unmatched: SceneLine[];
  /**
   * Speech in the prompt that is not a line of the scene's dialogue. Reported
   * only when dialogue was supplied, since there is nothing to compare against
   * otherwise.
   */
  extras: ExtraSpeech[];
};

/** A quotation that reads as speech but is not one of the scene's lines. */
export type ExtraSpeech = {
  words: string;
  /** True when the verb rule tagged it anyway, so H3 will say it. */
  tagged: boolean;
  /** The one known person its sentence names, when it names exactly one. */
  speaker?: string;
};

/**
 * Tag speech using the scene's own dialogue as the authority.
 *
 * Recognising speech by its verb missed most of it: the writing agent says
 * "speaks", "asks", "whispers" or "his voice carries", and only "says"/"said"
 * were tagged. An untagged line is description to H3, and with a voice
 * reference attached the character was heard improvising in that voice —
 * reading the scene's description aloud — rather than saying their line.
 *
 * So the verb rule runs first, unchanged, and then every quoted passage left
 * that matches a line of this scene's dialogue is tagged and attributed to that
 * line's speaker. A quote that matches no line (a sign, a title) is left alone,
 * and reported in `extras` when it reads as speech.
 *
 * Without dialogue the result is exactly what the verb rule alone produced.
 * `people` names everyone else who may be in the shot, so a sentence about two
 * of them is never read as being about one.
 */
export function markSceneDialogue(
  text: string,
  lines?: readonly SceneLine[],
  people: readonly string[] = [],
): DialogueMarking {
  const spoken = (lines ?? []).filter((entry) => entry.character.trim() && isSpokenLine(entry.line));
  const names = [...new Set([...spoken.map((entry) => entry.character.trim()), ...people.map((p) => p.trim())])]
    .filter(Boolean);
  DIALOGUE_TAG.lastIndex = 0;
  const premarked = DIALOGUE_TAG.test(text);
  DIALOGUE_TAG.lastIndex = 0;

  let marked = text;
  if (!premarked) {
    // One id per speaker for the whole prompt: a character who talks twice was
    // being numbered twice, which reads as two people and can be voiced as two.
    // An unnamed speaker still takes the next id, but shares it with no one.
    const ids = new Map<string, number>();
    let count = 0;
    const idFor = (key: string | undefined): number => {
      const known = key ? ids.get(key) : undefined;
      if (known !== undefined) return known;
      count += 1;
      if (key) ids.set(key, count);
      return count;
    };

    // A "said" inside a quotation is part of the line, not a new one: matching
    // it paired the line's own words with the next quotation along.
    const quoted = [...text.matchAll(QUOTED)].map((quote) => ({
      start: quote.index!,
      end: quote.index! + quote[0].length,
    }));
    marked = text.replace(
      SPOKEN_CLAUSE,
      (match, name: string | undefined, verb: string, delivery: string, line: string, offset: number) => {
        if (quoted.some((span) => offset > span.start && offset < span.end)) return match;
        const owner = lineFor(line, spoken)?.character ?? name;
        const id = idFor(owner?.toLocaleLowerCase());
        // How it is said belongs beside the verb, not inside the tag: the guide is
        // explicit that only the words between `<d>` and `</d>` are uttered, so a
        // delivery swept in there would be read out as part of the line.
        const said = `${verb}${delivery.replace(/[\s,:]+$/, "")}`;
        return `${name ? `${name} ` : ""}(S${id}) ${said}: <d>[English] ${line.trim()}</d>`;
      },
    );

    if (spoken.length) marked = tagSceneQuotes(marked, spoken, idFor, names);
  }

  const speakers: (string | undefined)[] = [];
  const heard = new Set<SceneLine>();
  const extras: ExtraSpeech[] = [];
  for (const match of marked.matchAll(SPEECH_CONTENT)) {
    const owner = lineFor(match[1] ?? "", spoken);
    speakers.push(owner?.character);
    if (owner) heard.add(owner);
    else if (lines !== undefined) {
      extras.push({
        words: (match[1] ?? "").trim(),
        tagged: true,
        speaker: soleNamed(sentenceBefore(marked, match.index!), names),
      });
    }
  }
  if (lines !== undefined) extras.push(...untaggedSpeech(marked, names));
  return {
    text: marked,
    speakers,
    unmatched: spoken.filter((entry) => !heard.has(entry)),
    extras,
  };
}

/** The words inside one `<d>` tag, without its language marker. */
const SPEECH_CONTENT = /<d>\s*(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>/g;

/** One spoken passage found in a prompt, in the order the prompt has it. */
export type PromptSpeech = {
  words: string;
  /** Who says it, when the prompt or the scene's dialogue makes that plain. */
  speaker?: string;
  /** How `speaker` was decided. */
  speakerFrom?: "card" | "named";
  /** The scene line this passage is — the same words, part of them, or a rewording. */
  cardLine?: SceneLine;
  /** The known person mentioned most recently before the passage: a guess, never a decision. */
  lastNamed?: string;
};

/**
 * Every passage of speech in a prompt, in order, with its speaker where known.
 *
 * The reverse of tagging: instead of asking whether the prompt says the card's
 * lines, it reads what the prompt says. A passage counts as speech when it is a
 * scene line (exactly, in part, or reworded) or when a speech word introduces
 * or follows it; a quoted sign or title does not. Its speaker is the card
 * line's, failing that the one known person its sentence names. A name inside
 * the quotation is never taken as the speaker — it is usually who is spoken to.
 */
export function speechInPrompt(
  text: string,
  lines?: readonly SceneLine[],
  people: readonly string[] = [],
): PromptSpeech[] {
  const spoken = (lines ?? []).filter((entry) => entry.character.trim() && isSpokenLine(entry.line));
  const names = [...new Set([...spoken.map((entry) => entry.character.trim()), ...people.map((p) => p.trim())])]
    .filter(Boolean);
  const { text: marked } = markSceneDialogue(text, lines, people);
  const passages: PromptSpeech[] = [];

  for (const match of marked.matchAll(/<d>\s*(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>|["“]([^"“”\n]+)["”]/g)) {
    const at = match.index!;
    const tagged = match[1] !== undefined;
    const words = (tagged ? match[1] : match[2])!.trim();
    if (!words) continue;
    const before = sentenceBefore(marked, at);
    const after = tagged ? "" : sentenceAfter(marked, at + match[0].length);
    const cardLine = lineFor(words, spoken);
    if (!tagged && !cardLine && !SPEECH_CUE.test(before) && !SPEECH_CUE.test(after)) continue;

    const named = soleNamed(`${before} ${after}`, names);
    // Names said aloud in earlier lines are addressees, not candidates.
    const preceding = marked.slice(0, at).replace(/<d>[\s\S]*?<\/d>|["“][^"“”\n]+["”]/g, " ");
    const lastNamed = names
      .map((name) => ({ name, at: lastMention(preceding, name) }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => b.at - a.at)[0]?.name;
    passages.push({
      words,
      ...(cardLine
        ? { speaker: cardLine.character, speakerFrom: "card" as const, cardLine }
        : named ? { speaker: named, speakerFrom: "named" as const } : {}),
      ...(lastNamed ? { lastNamed } : {}),
    });
  }
  return passages;
}

function lastMention(text: string, name: string): number {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return -1;
  let found = -1;
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"))) {
    found = match.index!;
  }
  return found;
}

/** A quoted passage, straight or curly. */
const QUOTED = /["“]([^"“”\n]+)["”]/g;

/**
 * Words that make a nearby quotation speech rather than a sign or a title.
 *
 * Used only to decide whether an unscripted quotation is worth a warning, so
 * it errs towards breadth; "called" alone is left out because "a bar called
 * "Eden"" names a place.
 */
const SPEECH_CUE =
  /\b(?:says?|said|saying|speaks?|spoke|speaking|ask(?:s|ed)?|shout(?:s|ed)?|yell(?:s|ed)?|cr(?:y|ies|ied)|scream(?:s|ed)?|whisper(?:s|ed)?|murmur(?:s|ed)?|mutter(?:s|ed)?|calls? out|called out|repl(?:y|ies|ied)|answer(?:s|ed)?|tells?|told|plead(?:s|ed)?|begs?|begged|exclaim(?:s|ed)?|gasp(?:s|ed)?|moan(?:s|ed)?|groan(?:s|ed)?|sigh(?:s|ed)?|hiss(?:es|ed)?|snap(?:s|ped)|growl(?:s|ed)?|laugh(?:s|ed)?|breathes?|breathed|sings?|sang|adds?|added|voice)\b/i;

/** Lower case, straight apostrophes, words only — so punctuation and quote style never decide a match. */
function normaliseSpeech(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The scene line a quoted passage is, if any.
 *
 * A passage may be a whole line, or part of one interrupted by delivery
 * (`"Still got it." she says. "Bare feet…"`). A part must run to two words, so
 * a one-word sign can only match a line that is exactly that word.
 *
 * Failing those, a passage that is plainly the same line reworded is still that
 * line — see `nearLine`.
 */
function lineFor(quote: string, lines: readonly SceneLine[]): SceneLine | undefined {
  const said = normaliseSpeech(quote);
  if (!said) return undefined;
  const exact = lines.find((entry) => normaliseSpeech(entry.line) === said);
  if (exact) return exact;
  if (said.split(" ").length < 2) return undefined;
  const part = lines.find((entry) => {
    const line = normaliseSpeech(entry.line);
    return ` ${line} `.includes(` ${said} `) ||
      (line.split(" ").length >= 2 && ` ${said} `.includes(` ${line} `));
  });
  return part ?? nearLine(said, lines);
}

/**
 * A line edited in the video prompt but not on the scene card.
 *
 * People reword lines in the prompt — "faster, baby" becomes "faster, Tracey,
 * my girl" — without touching the card, and an exact match then credits the
 * line to nobody: its speaker lost their voice, and a name inside it could be
 * mistaken for who was talking. Matching the reworded line to the card line it
 * came from credits it to that line's speaker, whatever name it mentions, and
 * H3 says the prompt's wording.
 *
 * The passage must keep most of the card line (60% of its words, and at least
 * three, or all of a shorter one) and the card line must be a fair share of the
 * passage. When two different speakers' lines score within reach of each other
 * the passage is left unmatched: a guess between speakers is how a voice ends
 * up on the wrong person.
 */
function nearLine(said: string, lines: readonly SceneLine[]): SceneLine | undefined {
  const quote = said.split(" ");
  const scored = lines
    .map((entry) => {
      const line = normaliseSpeech(entry.line).split(" ").filter(Boolean);
      const shared = sharedWords(quote, line);
      const close = line.length > 0 &&
        shared >= Math.min(3, line.length) &&
        shared / line.length >= 0.6 &&
        shared / quote.length >= 0.25;
      return { entry, score: close ? (2 * shared) / (quote.length + line.length) : 0 };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best] = scored;
  if (!best) return undefined;
  const speaker = (entry: SceneLine) => entry.character.trim().toLocaleLowerCase();
  const contested = scored.some((other) =>
    other !== best && speaker(other.entry) !== speaker(best.entry) && best.score - other.score < 0.15);
  return contested ? undefined : best.entry;
}

/** Words two passages have in common, counting repeats. */
function sharedWords(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const word of b) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of a) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(word, left - 1);
    }
  }
  return shared;
}

function namesSpeaker(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(escaped) && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** The one known person a passage names, or undefined when it names none or several. */
function soleNamed(text: string, names: readonly string[]): string | undefined {
  const found = names.filter((name) => namesSpeaker(text, name));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The lone "she" or "he" in a sentence about one person, which can safely
 * become the speaker's name.
 *
 * Refused whenever the sentence could be about two people: another known name,
 * pronouns of both kinds ("she watches as he shouts"), a plural, or the same
 * pronoun twice.
 */
function solePronoun(
  sentence: string,
  speaker: string,
  names: readonly string[],
): { index: number; length: number } | undefined {
  if (names.some((name) => name.toLocaleLowerCase() !== speaker.trim().toLocaleLowerCase() &&
    namesSpeaker(sentence, name))) return undefined;
  const feminine = /\b(?:she|her|hers|herself)\b/i.test(sentence);
  const masculine = /\b(?:he|him|his|himself)\b/i.test(sentence);
  const plural = /\b(?:they|them|their|theirs|themselves)\b/i.test(sentence);
  if ((feminine && masculine) || plural) return undefined;
  const subjects = [...sentence.matchAll(/\b(?:she|he)\b/gi)];
  if (subjects.length !== 1) return undefined;
  return { index: subjects[0]!.index!, length: subjects[0]![0].length };
}

/**
 * Tag the quoted scene lines the verb rule did not reach.
 *
 * The speaker id goes directly before the tag, as in the guide's own example
 * (`<Subject 1> says (S1) <d>…`). Where the sentence introducing the line does
 * not name its speaker, a pronoun binds no photograph and no voice, so the name
 * is supplied: in place of the pronoun when the sentence is plainly about the
 * speaker alone ("She shouts" becomes "TLBr3f shouts"), and otherwise just
 * before the tag ("his voice carries: Darius (S2) <d>…").
 */
function tagSceneQuotes(
  text: string,
  lines: readonly SceneLine[],
  idFor: (key: string | undefined) => number,
  names: readonly string[],
): string {
  const tagged = speechSpans(text);
  const edits = new Map<number, { end: number; replacement: string }>();
  for (const quote of text.matchAll(QUOTED)) {
    const offset = quote.index!;
    if (tagged.some((span) => offset >= span.start && offset < span.end)) continue;
    const words = quote[1] ?? "";
    const owner = lineFor(words, lines);
    if (!owner) continue;
    const name = owner.character.trim();
    const start = sentenceStart(text, offset);
    const sentence = text.slice(start, offset);
    let prefix = "";
    if (!namesSpeaker(sentence, name)) {
      const pronoun = solePronoun(sentence, name, names);
      if (pronoun) {
        edits.set(start + pronoun.index, { end: start + pronoun.index + pronoun.length, replacement: name });
      } else {
        prefix = `${name} `;
      }
    }
    const id = idFor(name.toLocaleLowerCase());
    edits.set(offset, {
      end: offset + quote[0].length,
      replacement: `${prefix}(S${id}) <d>[English] ${words.trim()}</d>`,
    });
  }
  return [...edits.entries()]
    .sort(([a], [b]) => b - a)
    .reduce((result, [at, edit]) => `${result.slice(0, at)}${edit.replacement}${result.slice(edit.end)}`, text);
}

function speechSpans(text: string): { start: number; end: number }[] {
  return [...text.matchAll(/<d>[\s\S]*?<\/d>/g)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

/**
 * Quoted speech still outside a tag: a quotation the scene's dialogue does not
 * have, introduced or followed by a speech word.
 */
function untaggedSpeech(text: string, names: readonly string[]): ExtraSpeech[] {
  const tagged = speechSpans(text);
  const extras: ExtraSpeech[] = [];
  for (const quote of text.matchAll(QUOTED)) {
    const offset = quote.index!;
    if (tagged.some((span) => offset >= span.start && offset < span.end)) continue;
    const before = sentenceBefore(text, offset);
    const after = sentenceAfter(text, offset + quote[0].length);
    if (!SPEECH_CUE.test(before) && !SPEECH_CUE.test(after)) continue;
    extras.push({ words: (quote[1] ?? "").trim(), tagged: false, speaker: soleNamed(`${before} ${after}`, names) });
  }
  return extras;
}

/** Where the sentence containing `offset` starts: after the last full stop or closing speech tag. */
function sentenceStart(text: string, offset: number): number {
  let start = 0;
  for (const match of text.slice(0, offset).matchAll(/[.!?]["”']?\s+|<\/d>/g)) {
    start = match.index! + match[0].length;
  }
  return start;
}

/** The current sentence up to `offset`. */
function sentenceBefore(text: string, offset: number): string {
  return text.slice(sentenceStart(text, offset), offset);
}

/** The rest of the current sentence from `offset`. */
function sentenceAfter(text: string, offset: number): string {
  const rest = text.slice(offset);
  const end = rest.search(/[.!?]["”']?(?:\s|$)|<d>/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Put tagged speech back to ordinary quoted prose for everything else. */
export function stripDialogueMarkup(text: string): string {
  return text.replace(DIALOGUE_TAG, (_match, line: string) => `"${line.trim()}"`);
}

/**
 * Assemble the envelope.
 *
 * One shot only: the guide says FL2VA "generally favors a single shot so the
 * model can interpolate continuously from the first frame to the last frame",
 * and a StoryForge scene is exactly one continuous take by construction.
 */
export function renderH3Prompt(parts: H3PromptParts): string {
  const mode = h3Mode(parts.hasStart, parts.hasEnd);
  const header = h3AlignmentHeader(mode, parts.durationSeconds);

  const body = markDialogue(tidy(parts.body), parts.dialogue);
  const continuation = parts.hasVideoSource
    ? "Continue directly from <Video 1>'s final frame, preserving its subjects, appearance, " +
      "props, setting, lighting, camera trajectory, motion, and synchronized audio without a reset."
    : "";
  const timelineBody = [continuation, body.replace(/^\[Shot 1\]\s*/, "")]
    .filter(Boolean)
    .join(" ");
  const timeline = `${SHOT} ${timelineBody}`;

  const fields = [
    `integrated_multimodal_description: ${timeline}`,
    `overall_soundscape: ${tidy(parts.soundscape) || "N/A"}`,
    `non_diegetic_music: ${tidy(parts.score) || "N/A"}`,
  ].join("\n");

  return withoutBlankLines(header ? `${header}\n${fields}` : fields);
}

/** Whether a prompt has already been put in the envelope. */
export function isH3Prompt(prompt: string): boolean {
  return prompt.includes("integrated_multimodal_description:");
}

/**
 * Fold the two audio layers back into the prose.
 *
 * H3's directive asks the prompt agent to keep ambience and score out of the
 * timeline and put them in fields of their own. Without the envelope those
 * fields have nowhere to go, and a model that writes its own soundtrack is then
 * given no audio direction at all — which is not neutral. Left to invent one it
 * will, and an unguided clip sang a line the scene had only asked it to say.
 */
export function appendAudioProse(
  prompt: string,
  soundscape?: string,
  score?: string,
): string {
  const layers = [tidy(soundscape), tidy(score)].filter((layer) => layer && layer !== "N/A");
  if (!layers.length) return prompt;
  return `${prompt.trim()} ${layers.join(" ")}`.trim();
}

/**
 * Recover the plain timeline prose from an envelope.
 *
 * A prompt is written for the pinned model, but a pin can be missing from the
 * catalogue and fall through to the router — so the family a prompt was written
 * for is not always the family that renders it, exactly as `routeNegative`
 * documents. Handing `integrated_multimodal_description:` to a Wan model would
 * render those words rather than obey them.
 */
export function stripH3Envelope(prompt: string): string {
  if (!isH3Prompt(prompt)) return stripDialogueMarkup(prompt);

  const after = prompt.slice(prompt.indexOf("integrated_multimodal_description:"));
  // Reads either layout, so a prompt stored under one setting still strips
  // cleanly under the other.
  const timeline = after
    .replace(/^integrated_multimodal_description:\s*/, "")
    .split(/\s*(?:overall_soundscape|non_diegetic_music):/)[0] ?? "";

  const sound = /overall_soundscape:\s*([\s\S]*?)(?=\s*non_diegetic_music:|$)/.exec(prompt);
  const music = /non_diegetic_music:\s*([\s\S]*)$/.exec(prompt);

  // The audio layers are still direction, just unlabelled: folded back in so a
  // fallback render loses the format without losing the intent.
  const audio = [sound?.[1], music?.[1]]
    .map((value) => tidy(value))
    .filter((value) => value && value !== "N/A");

  return [tidy(timeline).replace(/^\[Shot 1\]\s*/, ""), ...audio]
    .map(stripDialogueMarkup)
    .join(" ")
    .trim();
}

/** H3 is the only family that takes this envelope. */
export function usesH3PromptFormat(family: ModelFamily): boolean {
  return family === "minimax";
}
