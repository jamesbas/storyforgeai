/**
 * The part of a person's appearance a render cannot be allowed to guess.
 *
 * A text-to-image model given a named man and no skin tone draws whatever its
 * prior favours. Live, a project's Black lead was described in prompts by his
 * build, age and gut — enough for every "is he described?" check to pass — and
 * rendered white in scene after scene until the prompts were fixed by hand.
 * Build and age drift visibly; skin tone and ethnicity are the traits a viewer
 * reads first, so they are extracted on their own and required on their own.
 *
 * Only ever quoted from a description someone wrote. Nothing here infers a
 * trait the description does not state.
 */

const PERSON_NOUN =
  "(?:man|woman|men|women|male|female|guy|girl|boy|person|gentleman|lady|teen(?:ager)?|" +
  "husband|wife|patron|stranger|lover|boyfriend|girlfriend|father|mother|dad|mom|mum|" +
  "grandfather|grandmother|grandpa|grandma)";

const ETHNICITY =
  "(?:Black|White|Asian|East[- ]Asian|South[- ]Asian|Southeast[- ]Asian|Latino|Latina|Latinx|" +
  "Hispanic|African[- ]American|Afro[- ]Caribbean|African|Caribbean|Caucasian|Indian|Arab|" +
  "Middle[- ]Eastern|Mixed[- ]race|Biracial|Pacific[- ]Islander|Native[- ]American|Indigenous|" +
  "Filipino|Filipina|Japanese|Chinese|Korean|Vietnamese|Thai|Mexican|Persian|Turkish|Polynesian)";

/**
 * An ethnicity word attached to a person, allowing two words between them —
 * "Black man", "heavyset Black man", "Black middle-aged man". "Black hair" and
 * "black lace bra" never reach a person noun, so they are not read as one.
 */
const ETHNIC_PERSON = new RegExp(
  `(?<![\\p{L}-])(${ETHNICITY})(?!-?(?:hair|haired|eyes|eyed))\\s+(?:[\\p{L}][\\p{L}-]*\\s+){0,2}?(${PERSON_NOUN})(?![\\p{L}])`,
  "iu",
);

/** Words that say what colour skin is, as opposed to its texture. */
const SKIN_COLOUR = new Set([
  "dark", "deep", "light", "pale", "fair", "olive", "tan", "tanned", "bronze", "bronzed",
  "brown", "black", "ebony", "espresso", "mahogany", "chestnut", "caramel", "golden",
  "porcelain", "ivory", "freckled", "ruddy", "rosy", "umber", "cocoa", "chocolate", "honey",
  "copper", "coffee", "alabaster", "milky", "peach", "peachy", "pink", "sallow", "swarthy",
  "walnut", "cinnamon", "toffee", "mocha", "sepia", "russet", "amber", "sun-kissed",
  "sunkissed", "weathered", "creamy", "white",
]);

/** Words that end the adjective run before "skin" rather than belonging to it. */
const SKIN_RUN_BREAK = new Set([
  "with", "and", "has", "have", "his", "her", "their", "the", "a", "an", "of", "in", "on",
  "is", "are", "was", "whose", "its", "to", "by", "under", "over",
]);

export type Complexion = {
  /** "Black", as written. */
  ethnicity?: string;
  /** "man", the noun the ethnicity was attached to. */
  personNoun?: string;
  /** "dark espresso-brown skin" or "olive-skinned", as written. */
  skin?: string;
  /** The colour words of `skin`, lowercased, for recognising a paraphrase. */
  colours: string[];
};

const words = (text: string) => text.match(/[\p{L}][\p{L}'-]*/gu) ?? [];

/** Punctuation that ends the run of adjectives before "skin". */
const RUN_PUNCTUATION = /[;,.:()!?\u2014\u2013]/g;

function skinPhrase(text: string): { phrase: string; colours: string[] } | undefined {
  return skinPhrases(text)[0];
}

/** Every coloured skin phrase in `text`, in order. */
function skinPhrases(text: string): { phrase: string; colours: string[] }[] {
  const found: { phrase: string; colours: string[] }[] = [];
  const pattern = /(?<![\p{L}-])(?:([\p{L}][\p{L}-]*)-skinned|skin|complexion)(?![\p{L}-])/giu;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) {
      const colours = match[1].toLocaleLowerCase().split("-").filter((part) => SKIN_COLOUR.has(part));
      if (colours.length) found.push({ phrase: match[0], colours });
      continue;
    }
    const before = text.slice(0, match.index);
    const lastStop = Math.max(-1, ...[...before.matchAll(RUN_PUNCTUATION)].map((stop) => stop.index));
    const run: string[] = [];
    for (const word of words(before.slice(lastStop + 1)).reverse()) {
      if (SKIN_RUN_BREAK.has(word.toLocaleLowerCase()) || run.length === 3) break;
      run.unshift(word);
    }
    const colours = run.flatMap((word) =>
      word.toLocaleLowerCase().split("-").filter((part) => SKIN_COLOUR.has(part)));
    if (colours.length) found.push({ phrase: `${run.join(" ")} ${match[0]}`, colours });
  }
  return found;
}

/** Skin tone and ethnicity stated in a description. Empty when it states neither. */
export function complexionOf(description: string): Complexion {
  const ethnic = ETHNIC_PERSON.exec(description);
  const skin = skinPhrase(description);
  return {
    ...(ethnic ? { ethnicity: ethnic[1]!, personNoun: ethnic[2]!.toLocaleLowerCase() } : {}),
    ...(skin ? { skin: skin.phrase } : {}),
    colours: skin?.colours ?? [],
  };
}

export function hasComplexion(complexion: Complexion): boolean {
  return Boolean(complexion.ethnicity || complexion.skin);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/**
 * The complexion as one phrase that can sit beside a name.
 *
 * "a Black man with dark espresso-brown skin", "a Black man", or
 * "with olive skin" — the last reads correctly after a name in parentheses.
 */
export function complexionPhrase(complexion: Complexion): string | undefined {
  const { ethnicity, personNoun, skin } = complexion;
  const skinClause = skin
    ? /-skinned$/i.test(skin) ? skin : `with ${skin}`
    : undefined;
  if (ethnicity && personNoun) {
    const person = `${article(ethnicity)} ${ethnicity} ${personNoun}`;
    if (!skinClause) return person;
    return /-skinned$/i.test(skin!) ? `${article(skin!)} ${skin} ${ethnicity} ${personNoun}` : `${person} ${skinClause}`;
  }
  if (!skinClause) return undefined;
  return /-skinned$/i.test(skinClause) ? `${article(skinClause)} ${skinClause} person` : skinClause;
}

/** Whether `text` already conveys this complexion, in the description's words or a paraphrase. */
export function conveysComplexion(text: string, complexion: Complexion): boolean {
  if (!hasComplexion(complexion)) return true;
  if (complexion.ethnicity) {
    const stated = new RegExp(ETHNIC_PERSON.source, "giu");
    const wanted = complexion.ethnicity.toLocaleLowerCase().replace(/[- ]/g, "");
    for (const match of text.matchAll(stated)) {
      if (match[1]!.toLocaleLowerCase().replace(/[- ]/g, "") === wanted) return true;
    }
  }
  // Every skin phrase, not just the first: a sentence naming two people often
  // describes the other one's skin before this one's.
  if (skinPhrases(text).some((skin) => skin.colours.some((colour) => complexion.colours.includes(colour)))) {
    return true;
  }
  return colouredBodyPart(text, complexion.colours);
}

/** Parts of a body whose colour is the person's skin colour. */
const BODY_PART =
  /^(?:hands?|fists?|fingers?|arms?|forearms?|shoulders?|chest|belly|gut|stomach|torso|back|body|face|cheeks?|neck|thighs?|legs?|knees?|feet|calves|hips?|buttocks|ass|flesh)$/i;

/**
 * "Leroy's espresso-brown hands" states his skin tone as surely as "his
 * espresso-brown skin" does. One of the description's own colour words on a
 * body part, with at most one word between — never hair or eyes, which have
 * colours of their own.
 */
function colouredBodyPart(text: string, colours: readonly string[]): boolean {
  if (!colours.length) return false;
  const tokens = words(text).map((word) => word.toLocaleLowerCase());
  return tokens.some((token, i) =>
    token.split("-").some((part) => colours.includes(part)) &&
    [tokens[i + 1], tokens[i + 2]].some((next) => next !== undefined && BODY_PART.test(next)));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The name as a proper noun: case-sensitive, so a character called Rose is not
 * found in "the sun rose", and not followed by more letters.
 */
function namePattern(name: string, flags = "u"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(name.trim())}(?![\\p{L}\\p{N}])`, flags);
}

/** The sentences of `body` that name this person. */
export function sentencesNamingPerson(body: string, name: string): string {
  const pattern = namePattern(name);
  return body.split(/(?<=[.!?])\s+/).filter((sentence) => pattern.test(sentence)).join(" ");
}

/** Whether the sentences naming this person state their complexion. */
export function complexionStatedFor(body: string, name: string, complexion: Complexion): boolean {
  const phrase = complexionPhrase(complexion);
  // What this module inserts always counts, whatever the matching makes of it.
  if (phrase && body.includes(`${name.trim()} (${phrase})`)) return true;
  return conveysComplexion(sentencesNamingPerson(body, name), complexion);
}

/** Character ranges inside straight or curly double quotes: dialogue, never edited. */
function quotedSpans(text: string): [number, number][] {
  return [...text.matchAll(/"[^"]*"|\u201c[^\u201d]*\u201d/g)].map((match) => [match.index, match.index + match[0].length]);
}

/**
 * State the complexion beside the person's first plain mention.
 *
 * Beside the name rather than in a sentence of its own, for the reason the cast
 * sheet gives: a text encoder has never heard of "Leroy", so a name in one
 * sentence and a skin tone in another are two people to it. A possessive
 * ("Leroy's thigh") cannot take a parenthesis gracefully, and a name inside
 * quoted dialogue is something a character says, so the first mention that is
 * neither is used; with none, the body is left as it is and the caller's sheet
 * carries the trait. Structured (JSON) prompts are never edited.
 */
export function withComplexionBesideName(body: string, name: string, complexion: Complexion): string {
  if (body.trimStart().startsWith("{")) return body;
  if (complexionStatedFor(body, name, complexion)) return body;
  const phrase = complexionPhrase(complexion);
  if (!phrase) return body;
  const quoted = quotedSpans(body);
  const mentions = body.matchAll(new RegExp(
    `(?<![\\p{L}\\p{N}])${escape(name.trim())}(?![\\p{L}\\p{N}'\u2019])`,
    "gu",
  ));
  const mention = [...mentions].find((match) =>
    !quoted.some(([from, to]) => match.index >= from && match.index < to));
  if (!mention) return body;
  const at = mention.index + mention[0].length;
  return `${body.slice(0, at)} (${phrase})${body.slice(at)}`;
}

export type IdentityAnchor = { name: string; complexion: Complexion };

/** Everyone whose description states a complexion, library cast and story characters alike. */
export function identityAnchors(
  people: readonly { name: string; description: string; facialDescription?: string }[],
): IdentityAnchor[] {
  const seen = new Set<string>();
  const anchors: IdentityAnchor[] = [];
  for (const person of people) {
    const key = person.name.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const complexion = complexionOf(`${person.description} ${person.facialDescription ?? ""}`);
    if (hasComplexion(complexion)) anchors.push({ name: person.name.trim(), complexion });
  }
  return anchors;
}

/**
 * The people a frame names without stating the complexion their description gives.
 *
 * Only people the frame actually names: someone visible but unnamed is already
 * `participant_missing`, and reporting their skin tone as well says the same
 * thing twice.
 */
export function missingComplexion(
  text: string,
  anchors: readonly IdentityAnchor[],
  visible?: readonly string[],
): string[] {
  return anchors
    .filter((anchor) => visible === undefined ||
      visible.some((name) => name.toLocaleLowerCase() === anchor.name.toLocaleLowerCase()))
    .filter((anchor) => sentencesNamingPerson(text, anchor.name).length > 0)
    .filter((anchor) => !complexionStatedFor(text, anchor.name, anchor.complexion))
    .map((anchor) => anchor.name);
}
