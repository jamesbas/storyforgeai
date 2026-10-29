import { countWords, splitSentences } from "@/lib/agents/media-prompt-spec";

/**
 * What a keyframe may and may not say.
 *
 * A keyframe is one held instant. The scene card's `actionDescription` is
 * written for the clip — it narrates a movement from beginning to end — so
 * pasting it into a still puts motion, pace and sequence into a prompt that has
 * no time in it, and the image model draws those words instead of a pose.
 */

/**
 * Words for time passing, in a medium that has none.
 *
 * Camera travel, a stated duration and rhythm are unambiguous: a still has no
 * camera move, no length and no tempo to show, so they are safe to remove.
 *
 * Deliberately excludes bare action verbs. A still can legitimately read "her
 * hand rests on the door" or "caught mid-stride", and rejecting those would
 * repair correct prose — the v1.77 failure.
 */
export const CAMERA_TRAVEL_IN_STILL =
  /\b(?:push(?:es|ing|ed)?[- ]in|pull(?:s|ing)?[- ](?:out|back)|dollies|dolly(?:ing)? (?:in|out|left|right)|tracking shot|track(?:s|ed|ing)? (?:up|down|forward|back|in|out|left|right|alongside|with|movement|motion)|pan(?:s|ning|ned)? (?:left|right|across|to)|tilt(?:s|ing|ed)? (?:up|down)|cranes? (?:up|down)|zoom(?:s|ing|ed)? (?:in|out)|orbit(?:s|ing|ed)? (?:around|the)|camera (?:track|push|pull|pan|tilt|dolly|dollie|zoom|crane|orbit|follow|mov|travel|drift|glid|sweep|circl|ris|descend|begin|start|settl|swing|swoop|rack|whip)\w*)\b/i;

export const DURATION_IN_STILL =
  /\b(?:over (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few) seconds?|over the (?:next|following)|for (?:a moment|several seconds)|begins? (?:from here|to)|starts? to|continu(?:es?|ing) (?:to|into)|cuts? to|transitions? to|dissolves? (?:in)?to)\b/i;

export const RHYTHM_IN_STILL =
  /\b(?:rhythm\w*|tempo|repeatedly|continuous\w*|back and forth|in and out|steady pace|each thrust|every thrust|over and over)\b/i;

/**
 * An action narrated as it starts, goes on or happens in order.
 *
 * "begins her pole walk" and "as she pulled herself through the bars" are verbs
 * about time, not a pose. They are only grounds for a retry: unlike the groups
 * above, removing the clause could remove the action itself, so nothing edits a
 * prompt on these alone. A pose that merely implies a movement ("caught
 * mid-stride", "body turned away") stays out, for the reason given above.
 */
export const SEQUENCE_IN_STILL = new RegExp(
  [
    String.raw`(?:begins?|starts?|initiates?|proceeds? to|continu(?:es|ing)) (?:her|his|their|its|a|an|the|from|into)\b`,
    String.raw`tracking (?:movement|motion)`,
    String.raw`(?:as|after|before|while|once|until) (?:she|he|they|it) (?:pull|drop|rise|rose|mov|step|walk|spin|spun|rotat|slid|slide|climb|swing|swung|lift|transition|releas|settl|complet|finish|reach|approach)\w*`,
    String.raw`then (?:she|he|they|it|\w+ly)\b`,
    String.raw`transition(?:s|ing|ed)? (?:to|into|from)`,
    String.raw`(?:slowly|gradually|smoothly) (?:rises?|rising|moves?|moving|slides?|sliding|turns?|turning|pulls?|pulling|sways?|swaying)`,
  ].map((part) => `\\b(?:${part})`).join("|"),
  "i",
);

const REMOVABLE = [CAMERA_TRAVEL_IN_STILL, DURATION_IN_STILL, RHYTHM_IN_STILL];

/** Whether this prompt describes time passing rather than one held instant. */
export function describesMotion(text: string): boolean {
  return REMOVABLE.some((pattern) => pattern.test(text)) || SEQUENCE_IN_STILL.test(text);
}

/** A stated length of time, which can come out of a sentence without breaking it. */
const TIME_PHRASE =
  /\b(?:over (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few) seconds?|over the (?:next|following)[^,.;]*|for (?:a moment|several seconds))\b,?\s*/gi;

/**
 * A camera move inside a longer clause: the word "camera", its verb, and at most
 * a short complement ("camera tracking up through chrome reflection"). Stopping
 * there keeps the subject the clause goes on to describe.
 */
const CAMERA_PHRASE =
  /\bcamera\s+\w+(?:\s+(?:to|in|on|up|down|out|back|forward|toward|towards|across|around|through|over|past|into|from))*(?:\s+(?!(?:as|while|and|with|she|he|they|then)\b)[\w'-]+){0,2}/gi;

function raise(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

function endSentence(text: string): string {
  return text.replace(/[\s,;:]+$/, "").replace(/[.!?]+$/, "");
}

/**
 * Remove what a still cannot show, and nothing else.
 *
 * Stated durations come out as a phrase. A sentence about the camera goes
 * whole. In any other sentence a camera phrase comes out on its own, so the
 * framing it was written into survives; clauses carrying only rhythm or a
 * transition are dropped, and a sentence left with too little to mean anything
 * goes too. Quoted speech is never edited.
 */
export function stripMotion(text: string): string {
  const kept: string[] = [];
  for (const original of splitSentences(text)) {
    if (/["“”]/.test(original)) {
      kept.push(original);
      continue;
    }
    const sentence = raise(original.replace(TIME_PHRASE, ""));
    if (!REMOVABLE.some((pattern) => pattern.test(sentence))) {
      if (sentence) kept.push(sentence);
      continue;
    }
    if (/^\W*(?:the\s+)?camera\b/i.test(sentence)) continue;
    const remaining = endSentence(sentence)
      .split(/(?<=[,;])\s+/)
      .map((clause) => clause.replace(CAMERA_PHRASE, " ").replace(/\s+/g, " ").trim())
      .filter((clause) => clause && !REMOVABLE.some((pattern) => pattern.test(clause)));
    const joined = endSentence(remaining.join(" "));
    if (countWords(joined) >= 4) kept.push(`${raise(joined)}.`);
  }
  return kept.join(" ");
}

/** Where an action says what it comes to, rather than how it goes. */
const RESOLUTION = /\b(?:until|finally)\s+/i;

function head(sentence: string): string {
  const at = RESOLUTION.exec(sentence);
  const before = at ? sentence.slice(0, at.index).replace(/[\s,;]+$/, "") : sentence;
  return before || sentence;
}

function tail(sentence: string): string | undefined {
  const at = RESOLUTION.exec(sentence);
  const after = at ? sentence.slice(at.index + at[0].length) : "";
  return after.trim() ? raise(after) : undefined;
}

/**
 * The two held instants an action runs between, from the card's own words.
 *
 * The deterministic builders have no model to turn a movement into a pose, so
 * this does the part that can be done without one: the first sentence is where
 * the action opens, and what it settles on ("until she sits") is where it
 * closes. Both frames used to receive the whole narrated action, which put the
 * same sequence of movements in the opening and closing frame alike.
 *
 * Empty strings when the card has no action.
 */
export function stillStates(action: string | undefined): { start: string; end: string } {
  const sentences = splitSentences(stripMotion(action ?? "")).map(endSentence).filter(Boolean);
  const first = sentences[0];
  const last = sentences[sentences.length - 1];
  if (!first || !last) return { start: "", end: "" };
  return { start: head(first), end: tail(last) ?? last };
}
