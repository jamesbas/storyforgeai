import {
  castContinuityClause,
  castPromptSuffix,
  describedInline,
  describesAppearance,
  storyCharacters,
  storySheetEntry,
  type StoryCharacter,
} from "@/lib/agents/cast";
import {
  complexionOf,
  complexionPhrase,
  complexionStatedFor,
  hasComplexion,
  sentencesNamingPerson,
  withComplexionBesideName,
} from "@/lib/agents/identity";
import { frameCast, charactersInScene } from "@/lib/agents/scene-cast";
import { othersInFrame, othersWardrobeSuffix, wardrobeChangeClause } from "@/lib/agents/wardrobe";
import { isTightShot } from "@/lib/media/seam";
import type { Character } from "@/lib/schemas/character";
import type { Scene } from "@/lib/schemas/storyboard";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";

type Bible = { characters: readonly { name: string; description: string }[] };

const CHARACTER_MARKER = " Character continuity — ";
const WARDROBE_MARKER = " Wardrobe continuity — ";

/**
 * Everything appended to one keyframe prompt for the people in it.
 *
 * Library cast get their sheet, story characters (people the visual bible
 * introduced) get the same fallback, and anyone whose description states a skin
 * tone or ethnicity the prompt left out has it stated beside their name. One
 * function for the prompt writer, the stored-prompt rebuild and the
 * deterministic builder, so the three cannot disagree about what a prompt
 * should end with — the rebuild compares against exactly this.
 */
export function composeFrameCast(args: {
  body: string;
  cast: readonly Character[];
  wardrobeAt?: Record<string, string>;
  options: { faceVisible?: boolean; tightShot?: boolean };
  story: readonly StoryCharacter[];
  /** This frame's visibility list; undefined means "whoever the body names". */
  visible?: readonly string[];
  /** Outfits of non-library people in this frame, already narrowed to it. */
  others: Record<string, string>;
}): string {
  const { cast, story, visible } = args;
  // A structured (Fibo JSON) prompt is composed exactly as it always was:
  // nothing new is inserted into it or appended after it, which would leave
  // text outside the JSON and fail to parse at render time.
  if (args.body.trimStart().startsWith("{")) {
    return `${args.body}${castPromptSuffix(cast, args.wardrobeAt, args.options, args.body)}` +
      othersWardrobeSuffix(args.others, args.body);
  }
  const pinned = new Set(cast.map((c) => c.name.trim().toLocaleLowerCase()));
  const named = (name: string) => sentencesNamingPerson(args.body, name).length > 0;
  const storyHere = story.filter((person) =>
    !pinned.has(person.name.toLocaleLowerCase()) &&
    (visible === undefined || visible.some((v) => v.toLocaleLowerCase() === person.name.toLocaleLowerCase())) &&
    named(person.name));
  const castSize = Math.max(1, cast.length + storyHere.length);

  // Complexion first, beside the name, for everyone the body already describes.
  // Someone it does not describe gets the whole sheet, which carries it. Where
  // the only mentions are possessive ("Leroy's forearm") there is no grammatical
  // place beside the name, so a one-line entry in the sheet carries it instead.
  let body = args.body;
  const complexionNotes: string[] = [];
  const stateComplexion = (name: string, complexion: ReturnType<typeof complexionOf>) => {
    const next = withComplexionBesideName(body, name, complexion);
    const phrase = complexionPhrase(complexion);
    if (next === body && phrase && !complexionStatedFor(body, name, complexion)) {
      complexionNotes.push(`${name}: ${phrase}.`);
    }
    body = next;
  };
  for (const person of cast) {
    const complexion = complexionOf(`${person.description} ${person.facialDescription ?? ""}`);
    // Judged at the library's own cast size — the one `castPromptSuffix` uses to
    // decide whether to append the sheet — so a person is never "described"
    // for one decision and "not described" for the other, and left with neither.
    if (hasComplexion(complexion) && named(person.name) && describedInline(body, person, cast.length)) {
      stateComplexion(person.name, complexion);
    }
  }
  for (const person of storyHere) {
    const complexion = complexionOf(person.identity);
    if (hasComplexion(complexion) &&
      describesAppearance(body, person.name, person.identity, castSize, { complexionSuffices: true })) {
      stateComplexion(person.name, complexion);
    }
  }

  const library = castPromptSuffix(cast, args.wardrobeAt, args.options, body);
  const outfitOf = (name: string) => Object.entries(args.others)
    .find(([subject]) => subject.toLocaleLowerCase() === name.toLocaleLowerCase())?.[1];
  const undescribed = storyHere.filter((person) =>
    !describesAppearance(body, person.name, person.identity, castSize, { complexionSuffices: true }));
  const storySheet = [
    ...undescribed.map((person) => storySheetEntry(person, outfitOf(person.name), castSize)),
    ...complexionNotes,
  ].join(" ");
  const covered = new Set(undescribed.map((person) => person.name.toLocaleLowerCase()));
  const remaining = Object.fromEntries(Object.entries(args.others)
    .filter(([subject]) => !covered.has(subject.toLocaleLowerCase())));

  return `${body}${mergeCharacterSheets(library, storySheet)}${othersWardrobeSuffix(remaining, body)}`;
}

/** One "Character continuity" block, however many kinds of people are in it. */
function mergeCharacterSheets(library: string, storySheet: string): string {
  if (!storySheet) return library;
  if (!library.startsWith(CHARACTER_MARKER)) return `${CHARACTER_MARKER}${storySheet}${library}`;
  const wardrobeAt = library.indexOf(WARDROBE_MARKER);
  return wardrobeAt < 0
    ? `${library} ${storySheet}`
    : `${library.slice(0, wardrobeAt)} ${storySheet}${library.slice(wardrobeAt)}`;
}

/**
 * Rebuild the parts of a stored prompt that were appended rather than written.
 *
 * The cast sheet, the wardrobe line and the clip's continuity clause are all
 * derived from the cast and the wardrobe timeline, so they can be recomputed
 * from scratch and swapped in — no model, no regeneration. That is what makes a
 * costume change applied after the prompts were written a mechanical repair
 * rather than a rewrite. The one edit inside the written text is a stated skin
 * tone or ethnicity placed beside a name the text describes without it, which
 * only ever adds words.
 *
 * Shared so the screen that offers the repair decides it is needed by the same
 * comparison the repair itself performs.
 */
export function rebuiltPrompts(
  scene: Scene,
  cast: readonly Character[],
  wardrobe: SceneWardrobe | undefined,
  bible?: Bible,
): { startFramePrompt: string; endFramePrompt: string; videoPromptSegment: string } {
  const sceneCast = charactersInScene(scene, cast);
  const story = storyCharacters(bible, cast);
  return {
    startFramePrompt: withCastSheet(
      scene.prompts.startFramePrompt,
      sceneCast,
      wardrobe?.start,
      wardrobe?.othersStart,
      scene,
      "start",
      story,
    ),
    endFramePrompt: withCastSheet(
      scene.prompts.endFramePrompt,
      sceneCast,
      wardrobe?.end,
      wardrobe?.othersEnd,
      scene,
      "end",
      story,
    ),
    videoPromptSegment: withVideoCastClause(
      scene.prompts.videoPromptSegment,
      sceneCast,
      wardrobeChangeClause(
        wardrobe?.within ?? [],
        sceneCast,
        wardrobe?.start ?? {},
        wardrobe?.othersStart ?? {},
      ),
    ),
  };
}

/** Whether any appended text on this scene no longer matches the cast or wardrobe. */
export function sheetIsStale(
  scene: Scene,
  cast: readonly Character[],
  wardrobe: SceneWardrobe | undefined,
  bible?: Bible,
): boolean {
  const next = rebuiltPrompts(scene, cast, wardrobe, bible);
  return (
    next.startFramePrompt !== scene.prompts.startFramePrompt ||
    next.endFramePrompt !== scene.prompts.endFramePrompt ||
    next.videoPromptSegment !== scene.prompts.videoPromptSegment
  );
}

function withCastSheet(
  prompt: string,
  sceneCast: readonly Character[],
  wardrobeAt: Record<string, string> | undefined,
  others: Record<string, string> | undefined,
  scene: Scene,
  frame: "start" | "end",
  story: readonly StoryCharacter[] = [],
): string {
  const cut = prompt.indexOf(CHARACTER_MARKER);
  const body = cut >= 0 ? prompt.slice(0, cut) : stripOthers(prompt);
  const options = {
    faceVisible: scene.subjectFaceVisible !== false,
    tightShot: isTightShot(body),
  };
  const selected = frameCast(scene, frame, body, sceneCast);
  const visible = scene.frameVisibility?.[frame];
  const outfits = visible === undefined ? othersInFrame(body, others ?? {}) :
    Object.fromEntries(Object.entries(others ?? {}).filter(([name]) => visible.includes(name)));
  return composeFrameCast({
    body, cast: selected, wardrobeAt, options, story, visible, others: outfits,
  });
}

function stripOthers(prompt: string): string {
  const cut = prompt.indexOf(WARDROBE_MARKER);
  return cut >= 0 ? prompt.slice(0, cut) : prompt;
}

/**
 * Two markers because the format changed: prompts written before the clip
 * stopped re-describing the cast end with the full sheet, later ones with the
 * short preservation clause.
 */
function withVideoCastClause(
  prompt: string,
  sceneCast: readonly Character[],
  change: string,
): string {
  const markers = [" Character continuity — ", " The start frame fixes how "];
  let body = prompt;
  for (const marker of markers) {
    const cut = body.indexOf(marker);
    if (cut >= 0) body = body.slice(0, cut);
  }
  return `${body}${castContinuityClause(sceneCast, change)}`;
}
