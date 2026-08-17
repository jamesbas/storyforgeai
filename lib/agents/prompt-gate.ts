import { splitSentences } from "@/lib/agents/media-prompt-spec";
import { namesExplicitContent } from "@/lib/agents/explicitness";
import { statedHeadcount } from "@/lib/media/seam";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * The acceptance gate between "the agent was instructed correctly" and "this
 * prompt actually depicts the scene".
 *
 * Everything upstream of here is instruction: the image agent is told to name
 * the anatomy, keep the action, and refuse euphemism. Nothing checked that it
 * did. The response contract asks for three strings, and a coy, generic or
 * half-empty prompt satisfies it exactly as well as a faithful one — so an
 * explicit scene could be planned correctly, prompted correctly, and still
 * render two people standing near each other.
 *
 * The first version of this gate asked whether the prompt contained *any*
 * explicit word, and "performs oral sex on Tracey; his mouth is pressed
 * against her soft skin between her thighs" passed it clean: the act was
 * labelled, and nothing an image model can draw was described. So the checks
 * below are sufficiency checks — anatomy, contact, position, asked separately,
 * because a prompt can satisfy one of them and none of the rest.
 */

export const PROMPT_GATE_CODES = [
  /** Nothing usable came back; a schema-valid empty string is still empty. */
  "prompt_blank",
  /** The scene's physical action is not in the prompt that renders it. */
  "action_dropped",
  /** A character the scene puts in this shot is not named in the prompt. */
  "participant_missing",
  /** The act was replaced by a phrase that names an idea rather than a thing. */
  "euphemism",
  /** No genital anatomy named, so the model is given no part to draw. */
  "anatomy_unnamed",
  /** Nothing says what is inside, against or around what. */
  "contact_unstated",
  /** No position, so the bodies have no arrangement to hold. */
  "position_unstated",
  /** Rhythm and pace in a still frame, which can show neither. */
  "motion_in_still",
  /** Clothing on a body the act undresses, which outranks the act. */
  "wardrobe_contradicts_act",
  /** The two frames of one scene disagree about how many people are in it. */
  "headcount_mismatch",
] as const;
export type PromptGateCode = (typeof PROMPT_GATE_CODES)[number];

export type ImageGateContext = {
  scene: SceneDraft;
  /** Cast the storyboard placed in this scene, by name. */
  participants: readonly string[];
  explicit: boolean;
  /**
   * Garment text this scene's wardrobe actually establishes, per frame.
   *
   * An outfit somebody chose is legitimate even in an explicit scene; an
   * outfit the model invented for a participant is the failure. This is what
   * tells the two apart.
   */
  establishedWardrobe?: { start: string; end: string };
  /**
   * This scene depicts a costume change on screen.
   *
   * The one scene where clothing in an explicit frame is not a fault: the start
   * frame is meant to show the old outfit and the end frame the new one, which
   * is what `wardrobeChangeDirective` already tells the agent.
   */
  wardrobeChange?: boolean;
  /**
   * This scene opens on the previous scene's end frame.
   *
   * That frame is inherited rather than rendered, and the agent is told to open
   * the prompt at what it already shows. Asking it to carry this scene's action
   * as well is asking for the one thing it must not do.
   */
  inheritsOpening?: boolean;
  /**
   * A clip will be rendered for this scene, so it can walk someone into frame.
   *
   * Defaults to permissive where it is unknown: a check that cannot be aimed
   * costs more in false rejections than it saves.
   */
  clipCarriesArrivals?: boolean;
};

/**
 * Phrases that name an idea instead of a thing.
 *
 * A diffusion model has no representation for an implication; given "their
 * union" it renders two people near each other. "Engages her from behind" is
 * the one that shipped — it reads as a description, passes every structural
 * check, and states nothing.
 */
const EUPHEMISMS: readonly RegExp[] = [
  /\bpoints? of contact\b/i,
  /\btheir union\b/i,
  /\bthe moment takes them\b/i,
  /\bcom(?:e|es|ing) together\b/i,
  /\bmak(?:e|es|ing) love\b/i,
  /\blovemaking\b/i,
  /\bengages? (?:her|him|them)\b/i,
  /\benters? (?:her|him)\b/i,
  /\b(?:he|she) takes (?:her|him)\b/i,
  /\bjoins? with\b/i,
  /\bbecom(?:e|es|ing) one\b/i,
  /\bintimate(?:ly)? (?:embrace|entwined|moment)\b/i,
  /\bfade(?:s)? to black\b/i,
  /\bcuts? away\b/i,
  /\boff[- ](?:screen|camera)\b/i,
  /\btastefully\b/i,
  /\bimplied\b/i,
  /\bsuggestive(?:ly)?\b/i,
  /\bdiscreetly\b/i,
];

/**
 * Whether this scene depicts a sexual act at all.
 *
 * Deliberately broad about *how* an act is worded, and it reads the euphemisms
 * too: a card saying "he engages her from behind" is a sex scene whose author
 * was coy, and the prompt written from it must not be.
 *
 * Nudity is deliberately **not** an act. A card reading "they pull her top down
 * until she is entirely nude" describes undressing, and asking that frame to
 * name genital anatomy is a demand the scene cannot meet — observed live on an
 * undressing scene whose prompt was correct, rejected for `anatomy_unnamed`,
 * and then repaired by pasting the card's action back into a still.
 */
const SEX_ACT =
  /\b(?:sex|sexual|intercourse|penetrat\w*|thrust\w*|straddl\w*|riding|mounts?|mounted|fellati\w*|blow ?job|cunnilingus|going down on|masturbat\w*|orgasm\w*|climax\w*|ejaculat\w*|fuck\w*|cocks?|dicks?|pussy|cunt|penis|vagina|vulva|labia|clitoris|clit|genitals?|makes? love|lovemaking|engages? (?:her|him)|enters? (?:her|him)|takes (?:her|him))\b/i;

/**
 * Whether the scene leaves anyone out of their clothes.
 *
 * A weaker condition than an act, and it gates a different check: clothing the
 * model invented is a fault wherever the card says someone is bare, but only an
 * act can be asked for anatomy, contact and a position.
 */
const UNDRESSED_STATE =
  /\b(?:nude|nudity|naked|topless|undressed|unclothed|strips?|stripped|bare (?:breasts?|skin|body)|nipples?|breasts)\b/i;

/** Parts a render can draw. Breasts are excluded: they do not establish an act. */
const GENITAL_ANATOMY =
  /\b(?:cocks?|dicks?|penis|shafts?|glans|balls|testicles|scrotum|pussy|cunt|vagina|vulvas?|labia|clitoris|clit|anus|asshole|arsehole)\b/i;

/**
 * What is inside, against or around what.
 *
 * Two forms, because a prompt states contact either way round: an explicit
 * insertion word, or a preposition governing a named part. The preposition
 * form allows at most two words between the two, so "performs oral sex on
 * Tracey; his mouth" cannot be read as contact — an early version matched on
 * proximity alone and did exactly that.
 */
const CONTACT =
  /\b(?:inserted|insertion|penetrat\w*|impaled|buried|sheathed|balls[- ]deep|to the base|half withdrawn|vaginal|anal|inside (?:her|him|them)|deep (?:in|into|inside))\b|\b(?:in|into|inside|against|around|between|down)\s+(?:the\s+|her\s+|his\s+|their\s+)?(?:[\w']+\s+){0,2}?(?:mouth|throat|lips|pussy|cunt|vagina|vulva|labia|clitoris|clit|anus|asshole|arsehole|buttocks|cocks?|penis|shafts?|balls)\b/i;

/**
 * An arrangement the bodies can be held in.
 *
 * Named positions and plain spatial staging both count. A prompt reading "Man
 * 1 is visible below ... his hands grip her hips" has placed every body in the
 * frame without using a single position name, and rejecting it taught the
 * model nothing.
 */
const POSITION =
  /\b(?:cowgirl|missionary|doggy(?:[- ]style)?|spit[- ]roast|straddl\w*|astride|on all fours|on (?:her|his) (?:back|knees|side|stomach|front)|bent over|kneel\w*|l(?:ying|ies|ay) (?:back|down|on)|pinned|mounted|riding|lean(?:s|ing)? over|stand(?:s|ing)? over|crouch\w*|on top of|below|above|beneath|underneath|behind (?:her|him)|over (?:her|him|them)|grip\w* (?:her|his) (?:hips|waist|thighs|head|hair)|between (?:her|his) (?:legs|thighs|knees)|legs? (?:over|around|either side|apart|spread)|spread (?:legs|wide|eagled)|from behind|face down|either side of|thighs either side|hips against)\b/i;

/**
 * Words for time passing, in a medium that has none.
 *
 * Three groups, and only unambiguous ones. A camera move named in a still is
 * always wrong — the frame has no camera travel to show. A stated duration is
 * always wrong for the same reason. The rhythm set was the original list and is
 * kept.
 *
 * Deliberately excludes bare action verbs. A still can legitimately read "her
 * hand rests on the door" or "caught mid-stride", and rejecting those would
 * repair correct prose — the v1.77 failure. Sequenced verbs are a quality
 * question rather than a fault, and belong in the advisory lint.
 */
const CAMERA_TRAVEL_IN_STILL =
  /\b(?:push(?:es|ing)?[- ]in|pull(?:s|ing)?[- ](?:out|back)|dollies|dolly(?:ing)? (?:in|out|left|right)|tracking shot|track(?:s|ing)? (?:left|right|alongside|with)|pan(?:s|ning)? (?:left|right|across|to)|tilt(?:s|ing)? (?:up|down)|cranes? (?:up|down)|zoom(?:s|ing)? (?:in|out)|orbit(?:s|ing)? (?:around|the)|camera (?:moves|travels|follows|drifts|glides|sweeps|circles|rises|descends|begins|starts|settles))\b/i;

const DURATION_IN_STILL =
  /\b(?:over (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few) seconds?|over the (?:next|following)|for (?:a moment|several seconds)|begins? (?:from here|to)|starts? to|continu(?:es?|ing) (?:to|into)|cuts? to|transitions? to|dissolves? (?:in)?to)\b/i;

const RHYTHM_IN_STILL =
  /\b(?:rhythm\w*|tempo|repeatedly|continuous\w*|back and forth|in and out|steady pace|each thrust|every thrust|over and over)\b/i;

/** Whether this prompt describes time passing rather than one held instant. */
function describesMotion(text: string): boolean {
  return (
    CAMERA_TRAVEL_IN_STILL.test(text) || DURATION_IN_STILL.test(text) || RHYTHM_IN_STILL.test(text)
  );
}

const GARMENTS =
  /\b(?:t-?shirts?|shirts?|blouses?|dress(?:es)?|skirts?|trousers|pants|jeans|denim|shorts|suits?|jackets?|coats?|bras?|brassieres?|panties|knickers|briefs|underwear|lingerie|robes?|gowns?|stockings|corsets?|socks|shoes|boots|leggings)\b/i;

const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "then",
  "than",
  "they",
  "them",
  "their",
  "there",
  "here",
  "have",
  "been",
  "will",
  "while",
  "when",
  "what",
  "which",
  "your",
  "hers",
  "himself",
  "herself",
  "toward",
  "towards",
  "about",
  "after",
  "before",
  "still",
  "shot",
  "frame",
  "scene",
  "camera",
]);

/**
 * Content words, lightly stemmed.
 *
 * The inflections that differ between a card and a prompt written from it are
 * almost all verb endings — "guides" against "guiding", "thrusts" against
 * "thrusting" — so those are stripped before truncating. Truncation alone left
 * "guide" and "guidi" as different words, which is how a paraphrase of a
 * sentence already in the prompt got appended to it a second time.
 */
function contentStems(text: string | undefined): Set<string> {
  const stems = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    stems.add(raw.replace(/(?:ing|ed|es|s)$/, "").slice(0, 4));
  }
  return stems;
}

/** Sentence identity, for "has the prompt already said this". */
function sentenceKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function coverage(required: Set<string>, present: Set<string>): number {
  if (!required.size) return 1;
  let hit = 0;
  for (const stem of required) if (present.has(stem)) hit += 1;
  return hit / required.size;
}

function cardText(scene: SceneDraft): string {
  return `${scene.actionDescription ?? ""} ${scene.visualDescription ?? ""} ${scene.storyBeat ?? ""}`;
}

/** Whether the card puts a sexual act in this scene, however coyly it says so. */
export function depictsSexAct(scene: SceneDraft): boolean {
  return SEX_ACT.test(cardText(scene));
}

/** Whether the card leaves anyone bare, whether or not an act follows. */
function depictsUndress(scene: SceneDraft): boolean {
  return UNDRESSED_STATE.test(cardText(scene)) || depictsSexAct(scene);
}

/** Sentences of the card that state outright what happens. */
function explicitSentences(scene: SceneDraft): string[] {
  return [scene.actionDescription, scene.visualDescription, scene.storyBeat]
    .flatMap((field) => splitSentences(field ?? ""))
    .filter(namesExplicitContent);
}

/**
 * Garments the prompt puts on somebody that this scene's wardrobe never did.
 *
 * Exported because the repair is not to argue with the sentence but to put the
 * garment in the negative prompt: a text encoder has no operator for "no
 * shirt", which is the whole reason `positiveGarments` exists.
 */
export function inventedGarments(prompt: string, established: string | undefined): string[] {
  const chosen = (established ?? "").toLowerCase();
  const found = prompt.toLowerCase().match(new RegExp(GARMENTS.source, "gi")) ?? [];
  return [...new Set(found)].filter((garment) => !chosen.includes(garment));
}

function tidy(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, "");
  return trimmed ? `${trimmed}.` : "";
}

/**
 * A third of the card's content words.
 *
 * Deliberately lenient. A faithful prompt rewrites the card rather than quoting
 * it, so demanding most of the vocabulary would reject good prose; a prompt
 * that has genuinely dropped the action shares almost none of it.
 */
const ACTION_COVERAGE = 1 / 3;

/**
 * How much of a sentence must already be in the prompt to count as said.
 *
 * The story beat is usually the action rewritten, so an exact-match check
 * cannot see it. Seven tenths of the content words is a restatement; less than
 * that is carrying something new.
 */
const PARAPHRASE_OVERLAP = 0.7;

/** What is wrong with this keyframe prompt, as codes. Empty means it passes. */
export function gateImagePrompt(
  prompt: string,
  frame: "start" | "end",
  ctx: ImageGateContext,
): PromptGateCode[] {
  const codes: PromptGateCode[] = [];
  const text = prompt.trim();
  if (text.split(/\s+/).filter(Boolean).length < 12) return ["prompt_blank"];

  const present = contentStems(text);
  const required = contentStems(ctx.scene.actionDescription);
  const met = required.size >= 4 ? coverage(required, present) >= ACTION_COVERAGE : coverage(required, present) > 0;
  // An inherited opening shows the previous scene's closing state by design, so
  // only the end frame can be held to this scene's action.
  if (!met && !(frame === "start" && ctx.inheritsOpening)) codes.push("action_dropped");

  // Not cosmetic: the cast sheet is appended only for characters the prompt
  // names, so a person left out of the prose is dropped from the render's
  // description of them entirely.
  const lower = text.toLowerCase();
  if (ctx.participants.some((name) => name.trim() && !lower.includes(name.trim().toLowerCase()))) {
    codes.push("participant_missing");
  }

  // Before the explicit branch: a keyframe is one held instant whatever the
  // scene contains, and this check spent its first three releases switched off
  // for every project that was not sexually explicit.
  if (describesMotion(text)) codes.push("motion_in_still");

  if (!ctx.explicit) return codes;
  if (EUPHEMISMS.some((pattern) => pattern.test(text))) codes.push("euphemism");

  // Anatomy, contact and position can only be asked of a frame that depicts an
  // act. Clothing is asked of any frame the card leaves someone bare in.
  if (depictsSexAct(ctx.scene)) {
    if (!GENITAL_ANATOMY.test(text)) codes.push("anatomy_unnamed");
    if (!CONTACT.test(text)) codes.push("contact_unstated");
    if (!POSITION.test(text)) codes.push("position_unstated");
  }
  if (!depictsUndress(ctx.scene)) return codes;

  const established =
    frame === "start" ? ctx.establishedWardrobe?.start : ctx.establishedWardrobe?.end;
  if (!ctx.wardrobeChange && inventedGarments(text, established).length) {
    codes.push("wardrobe_contradicts_act");
  }

  return codes;
}

/**
 * Faults only visible across the pair of frames.
 *
 * A gain the clip cannot carry, and nothing else. The end frame is rendered
 * with the start frame as a reference and told the cast looks exactly as it
 * does there; asked to add somebody who is not in that picture, the model
 * duplicates whoever is already in shot. With a clip there is no problem — it
 * walks them in — which is the same rule `conditionEndOnStart` applies at
 * render time, and this now agrees with it instead of guessing separately.
 *
 * Losing people is never a fault: a scene may legitimately end on someone
 * leaving. Flagging any change at all rejected an arrival and a departure that
 * both scene cards scripted deliberately.
 */
export function gateFramePair(
  startFrame: string,
  endFrame: string,
  options: { clipCarriesArrivals: boolean },
): PromptGateCode[] {
  if (options.clipCarriesArrivals) return [];
  const start = statedHeadcount(startFrame);
  const end = statedHeadcount(endFrame);
  return start !== null && end !== null && end > start ? ["headcount_mismatch"] : [];
}

/** Appended to the system prompt for the one retry, naming what was rejected. */
export function gateRepairDirective(
  codes: readonly PromptGateCode[],
  ctx: ImageGateContext,
): string {
  const reasons: string[] = [];
  if (codes.includes("prompt_blank")) {
    reasons.push("one or both frame prompts were empty or too short to render");
  }
  if (codes.includes("action_dropped")) {
    reasons.push(
      `neither frame described what the scene actually shows — "${tidy(ctx.scene.actionDescription)}" ` +
        "Both frames must describe that same action: the start frame at the instant it begins, " +
        "the end frame at the instant it finishes",
    );
  }
  if (codes.includes("participant_missing")) {
    reasons.push(
      `every person in the shot must be named in the prompt — ${ctx.participants.join(", ")}`,
    );
  }
  if (codes.includes("euphemism")) {
    reasons.push(
      "the act was replaced by a phrase naming an idea rather than a thing, which an image " +
        "model cannot draw",
    );
  }
  if (codes.includes("anatomy_unnamed")) {
    reasons.push(
      "no genital anatomy was named, so there is nothing for the model to draw — write it in " +
        'both registers, "his cock (penis)", "her pussy (vagina)"',
    );
  }
  if (codes.includes("contact_unstated")) {
    reasons.push(
      "nothing states what is inside or against what; say it outright — inserted, penetrating, " +
        "how deep, and where the two bodies join",
    );
  }
  if (codes.includes("position_unstated")) {
    reasons.push(
      "the position is not named; say which one — cowgirl, missionary, doggy style, straddling, " +
        "bent over — and where each limb is",
    );
  }
  if (codes.includes("motion_in_still")) {
    reasons.push(
      "you described rhythm or repetition, which a single frame cannot show; freeze it at one " +
        "instant and state how deep at that instant",
    );
  }
  if (codes.includes("wardrobe_contradicts_act")) {
    reasons.push(
      "you put clothing on someone taking part; every participant is naked unless this scene's " +
        "wardrobe dresses them",
    );
  }
  if (codes.includes("headcount_mismatch")) {
    reasons.push(
      "the closing frame adds someone the opening frame does not contain, and no clip will " +
        "carry them in; keep the same people in both",
    );
  }
  return (
    " Your previous answer was rejected and this is your one retry: " +
    reasons.join("; ") +
    ". Rewrite both frame prompts in full. Describe the visible state at that exact instant."
  );
}

/**
 * Put back what the model left out, from the card's own words.
 *
 * A last resort, used when the retry failed too. It cannot write the prompt the
 * agent should have written — a template has no way to choose a position — so
 * what it guarantees is that the concrete text the scene already holds reaches
 * the render rather than being quietly lost, and that the execution says so.
 *
 * Nothing is ever restated. The first version appended the whole action and
 * then appended that same action's explicit sentences individually, so a
 * repaired prompt carried the act three times — twice word for word and once as
 * the story beat's paraphrase of it. A diffusion model weights a repeated
 * sentence twice, which is the opposite of the intent.
 */
export function repairImagePrompt(
  prompt: string,
  frame: "start" | "end",
  codes: readonly PromptGateCode[],
  ctx: ImageGateContext,
): string {
  const body = prompt.trim();
  const said = new Set(splitSentences(body).map(sentenceKey));
  const stems = contentStems(body);

  /** A sentence the prompt does not already carry, in this or any other wording. */
  const unsaid = (sentence: string): string | undefined => {
    const text = tidy(sentence);
    if (!text) return undefined;
    const key = sentenceKey(text);
    if (said.has(key)) return undefined;
    const own = contentStems(text);
    if (own.size && coverage(own, stems) >= PARAPHRASE_OVERLAP) return undefined;
    said.add(key);
    for (const stem of own) stems.add(stem);
    return text;
  };

  const additions: string[] = [];
  // Only a missing part is repairable from the card. Pasting the scene's own
  // words can name anatomy the prompt never named, but it cannot choose a
  // position or state a contact the model declined to write — it would only
  // restate the action, which is what produced a prompt saying it three times.
  //
  // `action_dropped` is deliberately absent: it is a third of the card's
  // content words, which cannot tell a paraphrase from a drop. Live, it
  // rejected "pulling the blankets away to reveal her skin" against a card
  // reading "whip the blankets away, exposing her skin", and "at the moment of
  // climax" against "as he finishes" — both faithful, both better than the card.
  // It still earns a retry and a flag; it no longer edits a good prompt.
  const unnamed = codes.includes("anatomy_unnamed");

  if (codes.includes("euphemism") || unnamed) {
    const restated = splitSentences(ctx.scene.actionDescription ?? "")
      .map(unsaid)
      .filter((sentence): sentence is string => Boolean(sentence));
    if (restated.length) {
      const lead =
        frame === "start"
          ? "Shown at the first instant of this action:"
          : "Shown at the last instant of this action:";
      additions.push(`${lead} ${restated.join(" ")}`);
    }
  }
  if (unnamed) {
    for (const sentence of explicitSentences(ctx.scene)) {
      const text = unsaid(sentence);
      if (text) additions.push(text);
    }
  }
  if (codes.includes("wardrobe_contradicts_act")) {
    // Positive phrasing: the encoder cannot represent "no lingerie", so the
    // garment itself goes to the negative prompt instead.
    additions.push("Every participant is completely naked, bare skin throughout.");
  }
  if (codes.includes("participant_missing") && ctx.participants.length) {
    additions.push(`In frame: ${ctx.participants.join(", ")}.`);
  }
  if (codes.includes("prompt_blank") && !body) {
    const opening = unsaid(ctx.scene.visualDescription ?? "");
    if (opening) additions.unshift(opening);
  }
  return [body, ...additions].filter(Boolean).join(" ");
}
