import { isSpokenLine, speechInPrompt, type PromptSpeech, type SceneLine } from "@/lib/agents/h3-prompt";
import type { DialogueLine } from "@/lib/schemas/audio";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Bring a scene card's dialogue into line with what its video prompt says.
 *
 * The card's dialogue is not decoration: generation tags only the card's lines
 * as speech, ties each to its speaker's voice, and warns about — and withholds
 * a voice over — speech the card does not have. Someone who reworded a line in
 * the video prompt reasonably expected the prompt to be what counted, and it
 * was not. This reads the prompt's spoken lines back into the card instead of
 * asking them to retype them.
 *
 * Pure: the same scene always produces the same proposal, so the preview the
 * person approves is exactly what is saved.
 */

export type ProposedLine = DialogueLine & {
  /**
   * `unchanged`: the card already has this line. `reworded`: a card line the
   * prompt has changed. `new`: speech the card does not have.
   */
  status: "unchanged" | "reworded" | "new";
  /**
   * Where the speaker came from. `card` and `named` are reliable; `guessed`
   * needs a look; `unknown` must be chosen before it can be saved.
   */
  speakerFrom: "card" | "named" | "guessed" | "unknown";
  /** For a line the prompt rewrote, the card's wording it replaces. */
  replaces?: string;
};

export type DialogueSyncProposal = {
  sceneId: string;
  sceneNumber: number;
  title: string;
  before: DialogueLine[];
  /** The card's dialogue after syncing, in the prompt's order. */
  after: ProposedLine[];
  /** Card lines the prompt does not say, which syncing removes. */
  removed: DialogueLine[];
  /** Stage directions in the dialogue ("(Nods)"), which no prompt quotes and syncing keeps. */
  kept: DialogueLine[];
  /** True when syncing would leave the card with no spoken lines at all. */
  emptiesDialogue: boolean;
  /** Everyone a line may be given to: the cast, the card's speakers and who is in frame. */
  speakers: string[];
};

export type DialogueSyncSkip = { sceneId: string; sceneNumber: number; reason: string };

/** People a scene's lines could belong to, in a stable order. */
export function sceneSpeakers(scene: Scene, cast: readonly string[]): string[] {
  return [...new Set([
    ...cast,
    ...(scene.charactersPresent ?? []),
    ...(scene.dialogue ?? []).map((entry) => entry.character),
    ...(scene.frameVisibility?.start ?? []),
    ...(scene.frameVisibility?.end ?? []),
  ].map((name) => name.trim()).filter(Boolean))];
}

/** Card text without the quotation marks it sometimes arrives wrapped in. */
function bare(line: string): string {
  return line.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
}

function sameWords(a: string, b: string): boolean {
  const words = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim();
  return words(a) === words(b);
}

/**
 * What syncing this scene would do, or why it cannot.
 *
 * A passage's speaker is, in order: the speaker of the card line it matches;
 * the one person its sentence names; the speaker of the card line in the same
 * position when the prompt has as many lines as the card (a reworded line
 * keeps its place); the person named most recently before it. The last two are
 * marked as guesses, and a passage with none of these has no speaker until one
 * is chosen.
 */
export function proposeSceneDialogue(
  scene: Scene,
  cast: readonly string[],
): DialogueSyncProposal | DialogueSyncSkip {
  const base = { sceneId: scene.id, sceneNumber: scene.sceneNumber };
  const prompt = scene.prompts?.videoPromptSegment?.trim();
  if (!prompt) return { ...base, reason: "This scene has no video prompt to read dialogue from." };

  const before = (scene.dialogue ?? []).map((entry) => ({ character: entry.character, line: entry.line }));
  const spokenCard = before.filter((entry) => isSpokenLine(entry.line));
  const speakers = sceneSpeakers(scene, cast);

  // One card line the prompt split around its delivery ("Still got it." she
  // says. "Bare feet…") stays one line.
  const passages: PromptSpeech[] = [];
  for (const passage of speechInPrompt(prompt, before as SceneLine[], speakers)) {
    const last = passages[passages.length - 1];
    if (passage.cardLine && last?.cardLine === passage.cardLine) {
      last.words = `${last.words} ${passage.words}`;
    } else {
      passages.push({ ...passage });
    }
  }
  // A reworded line usually keeps its place, so when the prompt has as many
  // lines as the card, the card's speaker in the same position is a fair guess.
  const positional = passages.length === spokenCard.length;

  const claimed = new Set<DialogueLine>();
  for (const passage of passages) if (passage.cardLine) claimed.add(passage.cardLine as DialogueLine);
  const after: ProposedLine[] = passages.map((passage, index) => {
    const line = passage.words;
    const card = passage.cardLine as DialogueLine | undefined;
    if (card) {
      const same = sameWords(card.line, line);
      return {
        character: card.character,
        line,
        status: same ? "unchanged" : "reworded",
        speakerFrom: "card",
        ...(same ? {} : { replaces: bare(card.line) }),
      };
    }
    if (passage.speaker) {
      // Named by the prompt, and in the place of a card line of their own: the
      // same line, reworded, rather than a new line beside a removed one.
      const own = positional ? spokenCard[index] : undefined;
      if (own && !claimed.has(own) && own.character.trim().toLocaleLowerCase() === passage.speaker.toLocaleLowerCase()) {
        claimed.add(own);
        return { character: passage.speaker, line, status: "reworded", speakerFrom: "named", replaces: bare(own.line) };
      }
      return { character: passage.speaker, line, status: "new", speakerFrom: "named" };
    }
    const inPlace = positional ? spokenCard[index] : undefined;
    if (inPlace && !claimed.has(inPlace)) {
      claimed.add(inPlace);
      return { character: inPlace.character, line, status: "reworded", speakerFrom: "guessed", replaces: bare(inPlace.line) };
    }
    if (passage.lastNamed) return { character: passage.lastNamed, line, status: "new", speakerFrom: "guessed" };
    return { character: "", line, status: "new", speakerFrom: "unknown" };
  });

  // Stage directions keep their place in the list: no prompt quotes them, and
  // they are direction rather than speech, so the prompt is no authority on them.
  const kept = before.filter((entry) => !isSpokenLine(entry.line));
  for (const direction of kept) {
    const at = Math.min(before.indexOf(direction), after.length);
    after.splice(at, 0, { ...direction, status: "unchanged", speakerFrom: "card" });
  }

  const removed = spokenCard.filter((entry) => !claimed.has(entry));
  return {
    ...base,
    title: scene.title,
    before,
    after,
    removed,
    kept,
    emptiesDialogue: spokenCard.length > 0 && passages.length === 0,
    speakers,
  };
}

/** Whether a proposal would change anything that is saved. */
export function changesDialogue(proposal: DialogueSyncProposal): boolean {
  const saved = (lines: readonly DialogueLine[]) =>
    JSON.stringify(lines.map((entry) => [entry.character.trim(), entry.line.trim()]));
  return saved(proposal.before) !== saved(proposal.after);
}

export function isSkip(result: DialogueSyncProposal | DialogueSyncSkip): result is DialogueSyncSkip {
  return "reason" in result;
}
