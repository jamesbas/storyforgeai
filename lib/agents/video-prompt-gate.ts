import type { SceneDraft } from "@/lib/schemas/storyboard";

export interface VideoGateContext {
  scene: Pick<SceneDraft, "actionDescription" | "dialogue" | "visualDescription">;
  participants: readonly string[];
  /** Approved outfits, keyed by participant name, not character ID. */
  wardrobe?: Readonly<Record<string, string>>;
  /** Names of participants permitted to change clothes during this clip. */
  allowedWardrobeChanges?: readonly string[];
  /** Optional established frame descriptions; these are not motion instructions. */
  startFrame?: string;
  endFrame?: string;
}

type Span = { start: number; end: number };
type Word = Span & { value: string };
type Person = { name: string; pattern: string };
type SpeechCue = Span & { name: string };

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(value: string): Word[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function plain(value: string): string {
  return words(value).map((word) => word.value).join(" ");
}

function boundary(pattern: string): string {
  return `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
}

function people(names: readonly string[]): Person[] {
  const unique = [...new Map(names.map((name) => [plain(name), name.trim()])).values()].filter(Boolean);
  return unique.map((name) => {
    const parts = name.split(/\s+/);
    // A unique given name is useful; "Worker" must not stand for "Worker 2".
    const first = parts[0];
    const alias = parts.length > 1 && !/\d/.test(name) &&
      !/^(?:the|a|an|worker|guard|person|man|woman|dr\.?|mr\.?|ms\.?|mrs\.?)$/i.test(first) &&
      unique.filter((other) => plain(other.split(/\s+/)[0]) === plain(first)).length === 1;
    const full = escaped(name).replace(/\s+/g, "\\s+").replace(/['’]/g, "['’]");
    return { name, pattern: boundary(alias ? `${full}|${escaped(first)}` : full) };
  });
}

function mentions(text: string, person: Person): boolean {
  return new RegExp(person.pattern, "iu").test(text);
}

function occurrences(text: string, line: string): Span[] {
  const haystack = words(text);
  const needle = words(line).map((word) => word.value);
  if (!needle.length) return [];
  return haystack.flatMap((word, index) =>
    needle.every((value, offset) => haystack[index + offset]?.value === value)
      ? [{ start: word.start, end: haystack[index + needle.length - 1].end }]
      : [],
  );
}

function quotesIn(text: string): Span[] {
  // Single quotes inside words are apostrophes, not dialogue delimiters.
  return [...text.matchAll(/"[^"]*"|“[^”]*”|‘(?:[^’]|(?<=[\p{L}\p{N}])’(?=[\p{L}\p{N}]))*’|(?<![\p{L}\p{N}])'(?:[^']|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function withoutSpans(text: string, spans: readonly Span[]): string {
  return spans.reduce(
    (result, span) => result.slice(0, span.start) + " ".repeat(span.end - span.start) + result.slice(span.end),
    text,
  );
}

const ADVERB = "(?:(?:quietly|softly|loudly|gently|slowly|quickly|calmly|then|now)\\s+)*";
const SPEECH = "(?:says?|said|asks?|asked|repl(?:y|ies|ied)|whispers?|whispered|shouts?|shouted|tells?|told|adds?|added|answers?|answered|speaks?|responds?|remarks?|calls?)";

function speechCues(text: string, cast: readonly Person[], quotes: readonly Span[]): SpeechCue[] {
  const narrative = withoutSpans(text, quotes);
  return cast.flatMap((person) => {
    const direct = `${person.pattern}(?:['’]s\\s+voice)?\\s*(?::|\\s+${ADVERB}${SPEECH}\\b)`;
    const continued = `${person.pattern}\\s+${ADVERB}[\\p{L}]+(?:s|ed|ing)\\b[^.!?;\\n]{0,160}?\\b(?:and|then)\\s+${ADVERB}${SPEECH}\\b`;
    return [direct, continued].flatMap((pattern) =>
      [...narrative.matchAll(new RegExp(pattern, "giu"))].map((match) => ({
        name: person.name, start: match.index, end: match.index + match[0].length,
      })),
    );
  }).sort((a, b) => a.end - b.end || a.start - b.start);
}

function speakerFor(
  text: string, occurrence: Span, quotes: readonly Span[], cues: readonly SpeechCue[], cast: readonly Person[],
): string | undefined {
  const quote = quotes.find((span) => span.start < occurrence.start && span.end >= occurrence.end);
  if (quote) {
    const suffix = text.slice(quote.end);
    for (const person of cast) {
      const attribution = new RegExp(
        `^[ \\t,;—-]*(?:${person.pattern}\\s+${ADVERB}${SPEECH}|${SPEECH}\\s+${person.pattern})(?=[ \\t]*[.!?;]|[ \\t]*$)`,
        "iu",
      );
      if (attribution.test(suffix)) return person.name;
    }
  }
  const anchor = quote?.start ?? occurrence.start;
  const cue = cues.filter((candidate) => candidate.end <= anchor).at(-1);
  if (cue) {
    const gap = text.slice(cue.end, anchor);
    if (gap.length <= 100 && !/[.!?;\n]/.test(gap) &&
        !/\b(?:not|never|to (?:say|repeat)|asks? .+ to)\b/i.test(gap)) return cue.name;
  }
  return undefined;
}

const ACTOR_VERB = "(?:says?|said|asks?|replies|whispers?|shouts?|speaks?|responds?|enters?|arrives?|joins?|walks?|steps?|runs?|waves?|smiles?|nods?|hands?|carries|carry|opens?|closes?|picks?|lifts?|places?|reads?|writes?|wears?|removes?)";
const NON_NAMES = new Set([
  "a", "an", "the", "camera", "shot", "frame", "start", "end", "cut", "dolly",
  "pan", "music", "sound", "lighting", "light", "dialogue", "narration", "voice",
]);

function namedActors(text: string): string[] {
  return [...text.matchAll(new RegExp(
    `(?<![\\p{L}\\p{N}])([\\p{Lu}][\\p{L}’'-]*(?:[ \\t]+[\\p{Lu}][\\p{L}’'-]*){0,2})\\s+${ADVERB}${ACTOR_VERB}\\b`,
    "gu",
  ))].map((match) => match[1].replace(/^(?:Then|Meanwhile|While|As|And|But|Now|Suddenly)\s+/, ""))
    .filter((name) => !NON_NAMES.has(name.split(/\s+/)[0].toLowerCase()));
}

const STOP = new Set((
  "a an the and or but as at by for from in into of on onto to with without " +
  "is are was were be been being has have had do does did will would can could " +
  "he she they it his her their its him them this that these those " +
  "slowly quietly gently quickly calmly then now still while begins continues " +
  "say says said speak speaks speaking asks asked replies dialogue"
).split(/\s+/));

function stem(word: string): string {
  return word.replace(/ies$/, "y").replace(/ing$/, "").replace(/ed$/, "")
    .replace(/(?:ches|shes|sses|xes)$/, (suffix) => suffix.slice(0, -2))
    .replace(/s$/, "").replace(/e$/, "").replace(/([b-df-hj-np-tv-z])\1$/, "$1");
}

function content(text: string, cast: readonly Person[]): Set<string> {
  const anonymous = cast.reduce((body, person) => body.replace(new RegExp(person.pattern, "giu"), " "), text);
  return new Set(words(anonymous).map((word) => word.value)
    .filter((word) => word.length > 2 && !STOP.has(word) && !word.endsWith("ly")).map(stem));
}

function actorClauses(text: string, person: Person, cast: readonly Person[]): string[] {
  return [...text.matchAll(new RegExp(person.pattern, "giu"))].flatMap((match) => {
    const tail = text.slice(match.index + match[0].length).split(/[.!?;\n]/)[0];
    // A recipient ("Ben hands Ada a folder") is not an explicit actor clause.
    if (!new RegExp(`^\\s+(?:(?:is|are|will|can)\\s+)?${ADVERB}[\\p{L}]+(?:s|ed|ing)\\b`, "iu").test(tail) ||
        /^\s+(?:does\s+not|never|is\s+not)\b/i.test(tail)) return [];
    const next = cast.flatMap((other) => [...tail.matchAll(new RegExp(other.pattern, "giu"))])
      .map((other) => other.index).sort((a, b) => a - b)[0];
    return [next === undefined ? tail : tail.slice(0, next)];
  });
}

const GARMENT = /\b(?:t-?shirts?|shirts?|blouses?|sweaters?|jumpers?|hoodies?|jackets?|coats?|blazers?|trousers|pants|slacks|jeans|shorts|skirts?|dresses|dress|gowns?|uniforms?|suits?|overalls|boots?|shoes?|gloves?|hats?|scarves|scarfs)\b/gi;
const COLOUR = /\b(?:black|white|grey|gray|red|blue|navy|green|yellow|orange|purple|pink|brown|beige|silver|gold)\b/gi;

function garments(text: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let previousEnd = 0;
  for (const match of text.matchAll(GARMENT)) {
    const word = match[0].toLowerCase();
    const kind = /^(?:t-?shirts?|shirts?|blouses?|sweaters?|jumpers?|hoodies?)$/.test(word) ? "upper"
      : /^(?:jackets?|coats?|blazers?)$/.test(word) ? "outer"
      : /^(?:trousers|pants|slacks|jeans|shorts)$/.test(word) ? "lower"
      : /^(?:dresses|dress|gowns?|uniforms?|suits?|overalls)$/.test(word) ? "full"
      : word.replace(/s$/, "");
    const lead = text.slice(previousEnd, match.index).split(/\s+/).slice(-5).join(" ");
    const colours = (lead.match(COLOUR) ?? []).map((colour) =>
      colour.toLowerCase().replace(/^gray$/, "grey").replace(/^navy$/, "blue"),
    );
    result.set(kind, new Set([...(result.get(kind) ?? []), ...colours]));
    previousEnd = match.index + match[0].length;
  }
  return result;
}

type ClothingEvent = { owner: string; description: string; kind: "remove" | "change" | "undress"; garments: Set<string> };

function clothingEvents(text: string, cast: readonly Person[]): ClothingEvent[] {
  return cast.flatMap((person) => [...text.matchAll(new RegExp(
    `${person.pattern}\\s+(?:(?:is|was)\\s+)?${ADVERB}(undress(?:es|ed|ing)?|remov(?:es?|ed|ing)|(?:tak(?:es?|ing)|took|pull(?:s|ing)?)\\s+(?:off|(?:[\\p{L}’'-]+\\s+){1,6}?off)|slip(?:s|ping)?\\s+out\\s+of|strips?\\s+off|chang(?:es?|ed|ing)\\s+into)\\b([^.!?;\\n]*)`,
    "giu",
  ))].flatMap((match) => {
    if (/\b(?:do not|don't|never|avoid)\s+(?:let(?:ting)?\s+|hav(?:e|ing)\s+|show(?:ing)?\s+)?$/i
      .test(text.slice(Math.max(0, match.index - 35), match.index))) return [];
    const displaced = match[1].match(/^(?:tak(?:es?|ing)|took|pull(?:s|ing)?)\s+(.+)\s+off$/i)?.[1];
    const rest = displaced ?? match[2];
    const nextActor = cast.flatMap((other) => [...rest.matchAll(new RegExp(other.pattern, "giu"))])
      .filter((other) => !/^['’]s\b/.test(rest.slice(other.index + other[0].length)))
      .map((other) => other.index).sort((a, b) => a - b)[0];
    const description = (nextActor === undefined ? rest : rest.slice(0, nextActor))
      .split(/\b(?:while|then|but)\b|\band\s+(?:he|she|they|says?|walks?|opens?|picks?|carries|wears?)\b/i)[0].trim();
    const kind = match[1].toLowerCase().startsWith("undress") ? "undress"
      : match[1].toLowerCase().startsWith("chang") ? "change" : "remove";
    const items = new Set(garments(description).keys());
    if (kind === "remove" && !items.size) return [];
    // Removing another person's coat is a change for its owner, not its actor.
    const owner = cast.find((other) => new RegExp(
      `^\\s*${other.pattern}['’]s\\s+`, "iu",
    ).test(description))?.name ?? person.name;
    return [{ owner, kind, garments: items, description: displaced ? match[1] : `${match[1]} ${description}`.trim() }];
  }));
}

function short(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

/**
 * Pure, advisory lexical checks, not a semantic acceptance/rejection decision.
 * No rewrites, provider calls, filesystem access, or requirement to restate frames.
 */
export function gateVideoPrompt(text: string, context: VideoGateContext): string[] {
  if (!text.trim()) return ["Video prompt is blank; describe the scene's motion and any required spoken lines."];
  const warnings: string[] = [];
  const expected = people([...context.participants, ...(context.scene.dialogue ?? []).map((line) => line.character)]);
  const quotes = quotesIn(text);
  const narrative = withoutSpans(text, quotes);
  const source = `${context.scene.actionDescription} ${context.scene.visualDescription}`;
  const established = `${source} ${context.startFrame ?? ""} ${context.endFrame ?? ""}`;
  const unknown = people(namedActors(narrative).filter((name) =>
    !expected.some((person) => mentions(name, person)) && !mentions(established, people([name])[0]),
  ));
  const cast = people([...expected.map((person) => person.name), ...unknown.map((person) => person.name)]);
  const cues = speechCues(text, cast, quotes);
  const dialogueSpans: Span[] = [];
  for (const dialogue of context.scene.dialogue ?? []) {
    if (!plain(dialogue.line)) continue;
    const found = occurrences(text, dialogue.line);
    dialogueSpans.push(...found);
    const label = `${dialogue.character}: "${short(dialogue.line)}"`;
    if (!found.length) {
      warnings.push(`Missing dialogue for ${label}; include the line verbatim, spoken by ${dialogue.character}.`);
      continue;
    }
    const attributed = found.map((span) => speakerFor(text, span, quotes, cues, cast));
    if (attributed.some((name) => name && plain(name) === plain(dialogue.character))) continue;
    const wrong = [...new Set(attributed.filter((name): name is string => Boolean(name)))];
    warnings.push(wrong.length
      ? `Dialogue for ${label} appears assigned to ${wrong.join(", ")}; explicitly assign this line to ${dialogue.character}, not another speaker.`
      : `Speaker is unclear for ${label}; explicitly label ${dialogue.character} as the speaker of this verbatim line.`);
  }
  const body = withoutSpans(narrative, dialogueSpans);
  for (const person of people(context.participants)) {
    if (!mentions(body, person)) {
      warnings.push(`Participant ${person.name} is not explicitly identified in the video prompt; name this actor for their intended motion or speech.`);
    }
    const required = content(actorClauses(
      withoutSpans(context.scene.actionDescription, quotesIn(context.scene.actionDescription)), person, expected,
    ).join(" "), expected);
    const actual = content(actorClauses(body, person, cast).join(" "), cast);
    if (required.size >= 3 && actual.size >= 2 && ![...required].some((word) => actual.has(word))) {
      warnings.push(`Possible unrelated action for ${person.name}: no clear action-word overlap with "${short(context.scene.actionDescription)}"; preserve this actor's intended action rather than substitute another activity.`);
    } else if (required.size >= 3 && actual.size === 0 && mentions(body, person)) {
      warnings.push(`Possible missing action for ${person.name}; the scene gives this actor a physical beat, but the video prompt has no clear named action clause. Keep their intended motion, not only their dialogue or appearance.`);
    }
  }
  const required = content(withoutSpans(context.scene.actionDescription, quotesIn(context.scene.actionDescription)), expected);
  const actual = content(body, cast);
  if (required.size >= 4 && ![...required].some((word) => actual.has(word)) &&
      !warnings.some((warning) => warning.startsWith("Possible unrelated action"))) {
    warnings.push(`The video prompt may omit the scene action; retain the physical beat from "${short(context.scene.actionDescription)}" rather than camera motion alone.`);
  }
  for (const person of unknown) {
    warnings.push(`Possible unexpected participant ${person.name}; remove this added actor unless the scene or established frames authorize them.`);
  }
  const addition = body.match(/\b(?:another|an? additional|an? extra)\s+(?:person|worker|guard|guest|assistant)\s+(?:enters?|arrives?|joins?)\b/i)?.[0];
  if (addition && !plain(established).includes(plain(addition))) {
    warnings.push(`Possible added participant ("${addition}"); keep only the scene's intended participants.`);
  }
  const changes = clothingEvents(body, cast);
  const approvedChanges = clothingEvents(withoutSpans(source, quotesIn(source)), cast);
  const allowed = new Set((context.allowedWardrobeChanges ?? []).map(plain));
  for (const event of changes) {
    if (allowed.has(plain(event.owner))) continue;
    const authorised = approvedChanges.some((approved) =>
      plain(approved.owner) === plain(event.owner) && approved.kind === event.kind &&
      (event.kind === "undress" || plain(approved.description) === plain(event.description) ||
        (event.kind === "remove" && [...event.garments].every((item) => approved.garments.has(item)))),
    );
    if (!authorised) warnings.push(
      `Possible unauthorized wardrobe change for ${event.owner} ("${short(event.description)}"); preserve the approved outfit unless this change is explicitly intended.`,
    );
  }
  for (const [name, outfit] of Object.entries(context.wardrobe ?? {})) {
    if (allowed.has(plain(name))) continue;
    const person = people([name])[0];
    if (!person) continue;
    const approved = garments(outfit);
    const worn = [...body.matchAll(new RegExp(
      `${person.pattern}\\s*,?\\s+(?:(?:is|remains|stays)\\s+)?${ADVERB}(?:wears?|wearing|dressed\\s+in|clad\\s+in)\\s+([^.!?;\\n]+)`,
      "giu",
    ))];
    for (const match of worn) {
      const nextName = cast.flatMap((other) => [...match[1].matchAll(new RegExp(other.pattern, "giu"))])
        .map((other) => other.index).sort((a, b) => a - b)[0];
      const description = nextName === undefined ? match[1] : match[1].slice(0, nextName);
      const mismatch = [...garments(description)].some(([kind, colours]) => {
        const chosen = approved.get(kind);
        return chosen?.size && colours.size && ![...colours].some((colour) => chosen.has(colour));
      });
      if (mismatch) {
        warnings.push(`Possible wardrobe mismatch for ${name}: "${short(description)}" conflicts with approved outfit "${short(outfit)}"; keep the approved garment colours unless a change is authorized.`);
      }
    }
  }
  return [...new Set(warnings)];
}

const CAMERA_DIRECTION =
  /\b(?:camera|pans?|panning|tilts?|tilting|dolly|dollies|dollying|tracks?|tracking|cranes?|zoom(?:s|ing)?|push(?:es|ing)?\s+in|pull(?:s|ing)?\s+back|locked[- ]off|handheld|rack[- ]focus|focus\s+pull)\b/i;

function videoSentences(text: string, cast: readonly Person[]): string[] {
  const quotes = quotesIn(text);
  const ends = new Set<number>();
  for (let index = 0; index < text.length; index++) {
    if (/[.!?]/.test(text[index]) && (index + 1 === text.length || /\s/.test(text[index + 1])) &&
        !quotes.some((quote) => quote.start <= index && quote.end > index)) ends.add(index + 1);
  }
  for (const quote of quotes) {
    if (!/[.!?]/.test(text[quote.end - 2] ?? "") ||
        (quote.end < text.length && !/\s/.test(text[quote.end]))) continue;
    const suffix = text.slice(quote.end);
    const postfix = cast.some((person) => new RegExp(
      `^[ \\t]*(?:${person.pattern}\\s+${ADVERB}${SPEECH}|${SPEECH}\\s+${person.pattern})\\b`, "iu",
    ).test(suffix));
    if (!postfix) ends.add(quote.end);
  }
  ends.add(text.length);
  let start = 0;
  return [...ends].sort((a, b) => a - b).flatMap((end) => {
    const sentence = text.slice(start, end).trim();
    start = end;
    return sentence ? [sentence] : [];
  });
}

/**
 * Select original sentences worth protecting during budget trimming, in order.
 * This is not a replacement prompt or a guarantee they all fit the budget.
 * Keep verbatim required lines even when attribution itself needs repair.
 */
export function essentialVideoSentences(text: string, context: VideoGateContext): string[] {
  const dialogue = context.scene.dialogue ?? [];
  const expected = people([...context.participants, ...dialogue.map((line) => line.character)]);
  const cast = people([...expected.map((person) => person.name), ...namedActors(withoutSpans(text, quotesIn(text)))]);
  const action = withoutSpans(context.scene.actionDescription, quotesIn(context.scene.actionDescription));
  const required = content(action, expected);
  return videoSentences(text, cast).filter((sentence) => {
    const quotes = quotesIn(sentence);
    const narrative = withoutSpans(sentence, quotes);
    if (CAMERA_DIRECTION.test(narrative)) return true;
    if (dialogue.some((line) => occurrences(sentence, line.line).length)) return true;
    const cues = speechCues(sentence, cast, quotes);
    if (quotes.some((quote) => speakerFor(
      sentence, { start: quote.start + 1, end: quote.end - 1 }, quotes, cues, cast,
    ))) return true;
    const actorAction = expected.some((person) => {
      const wanted = content(actorClauses(action, person, expected).join(" "), expected);
      const present = content(actorClauses(narrative, person, cast).join(" "), cast);
      const overlap = [...wanted].filter((word) => present.has(word));
      return overlap.length >= 2 || overlap.includes([...wanted][0]);
    });
    if (actorAction) return true;
    // Pronoun-led continuations can still carry clear action/object anchors.
    const present = content(narrative, cast);
    return /^\s*(?:he|she|they|it)\b/i.test(narrative) &&
      [...required].filter((word) => present.has(word)).length >= 2;
  });
}

/** Optional model retry text. Empty findings do not add an instruction. */
export function videoGateRetryDirective(warnings: readonly string[]): string {
  if (!warnings.length) return "";
  return `Revise only the flagged video details; preserve the scene, speakers and approved wardrobe. Advisory checks may be incomplete: verify against the scene and frames.\n${[...new Set(warnings)].map((warning) => `- ${warning}`).join("\n")}`;
}
