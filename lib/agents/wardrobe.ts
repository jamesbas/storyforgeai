import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";
import type { SceneWardrobe, WardrobeChange } from "@/lib/schemas/wardrobe";
import { isContinuousTake } from "@/lib/agents/continuity";

/**
 * Resolve what each character wears at each end of every scene.
 *
 * Wardrobe is a timeline rather than a constant: the effective outfit for a
 * scene is the last change at or before it, which is how costume continuity
 * actually works. A `between` change is already done when the scene opens; a
 * `within` change is depicted, so that one scene has a different outfit at each
 * end and the clip renders the act of changing.
 *
 * Scenes must be supplied in running order — the walk carries state forward, so
 * a change in scene 7 has no way to reach scene 9 if 8 is missing from the
 * sequence.
 */
export function wardrobeTimeline(
  project: Project,
  scenes: readonly { id: string }[],
  cast: readonly Character[],
): Map<string, SceneWardrobe> {
  const current: Record<string, string> = {};
  for (const character of cast) {
    const wardrobe = wardrobeOf(project, character);
    if (wardrobe) current[character.id] = wardrobe;
  }
  // Unnamed people start with nothing established: whatever the first scene
  // they appear in decides. From then on it is carried like anyone else's.
  const others: Record<string, string> = {};

  const byId = new Map(cast.map((c) => [c.id, c] as const));
  const timeline = new Map<string, SceneWardrobe>();

  for (const scene of scenes) {
    const changes = (project.wardrobeChanges?.[scene.id] ?? []).filter(
      (c) => !c.characterId || byId.has(c.characterId),
    );
    const start = { ...current };
    const othersStart = { ...others };
    const within: WardrobeChange[] = [];

    for (const change of changes) {
      const wardrobe = change.wardrobe.trim();
      if (!wardrobe) continue;
      const target = change.characterId ? current : others;
      const opening = change.characterId ? start : othersStart;
      const key = change.characterId ?? change.subject!.trim();

      if (change.mode === "within") {
        within.push(change);
      } else {
        // Already changed by the time the scene opens, so both frames wear it.
        opening[key] = wardrobe;
      }
      target[key] = wardrobe;
    }

    timeline.set(scene.id, {
      start,
      end: { ...current },
      othersStart,
      othersEnd: { ...others },
      within,
    });
  }

  return timeline;
}

/**
 * Garments stated as absences, rewritten as the thing to draw instead.
 *
 * A text encoder has no operator for "no" — the project already knows this
 * about negative prompts and states it in `negative-prompt.ts`, but a wardrobe
 * string carrying "no shirt" goes into the *positive* prompt, where the same
 * rule applies and nobody was applying it. "black silk trousers, no shirt"
 * embeds `shirt`, and the render duly produced a man in a maroon polo. Worse,
 * the invented garment then travelled: the next frame, conditioned on that one,
 * put the maroon shirt on a different character entirely.
 *
 * Render prompts only. The stored wardrobe keeps the wording a person wrote.
 */
const NEGATED_GARMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bno (?:shirt|top|upper garments?)\b/gi, "bare chest"],
  [/\bshirtless\b/gi, "bare chest"],
  [/\bno (?:bra|brassiere)\b/gi, "bare breasts"],
  [/\bno (?:briefs|panties|knickers|underwear|undergarments)\b/gi, "bare hips"],
  [/\bno (?:shoes|footwear|socks)\b/gi, "bare feet"],
  [/\bno other (?:garments?|clothing|clothes)\b/gi, "and nothing else"],
];

export function positiveGarments(wardrobe: string): string {
  let text = wardrobe;
  for (const [pattern, replacement] of NEGATED_GARMENTS) text = text.replace(pattern, replacement);
  return text
    .replace(/,\s*and nothing else/gi, " and nothing else")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

/**
 * The clause carrying non-cast wardrobe into a prompt.
 *
 * Pinned characters get the cast sheet; everyone else had nothing at all, so
 * an unnamed man's shirt could drift from grey to blue between scenes with
 * nothing to stop it. Empty when no unnamed subject has an established outfit.
 *
 * Written as a sentence binding the subject to the garments, for the same
 * reason the cast sheet was: a bare `subject: outfit` pair is an attribute the
 * model attaches to whichever body suits it.
 */
export function othersWardrobeSuffix(others: Record<string, string>): string {
  const entries = Object.entries(others).filter(([, outfit]) => outfit.trim());
  if (entries.length === 0) return "";
  const sheet = entries
    .map(([subject, outfit]) => {
      const garments = positiveGarments(outfit.trim());
      return isUndressed(outfit)
        ? `${subject} is completely naked with no clothing.`
        : `${subject} is dressed in ${garments}.`;
    })
    .join(" ");
  return ` Wardrobe continuity — ${sheet}`;
}

const SUBJECT_STOP_WORDS = new Set(["the", "a", "an", "and", "of", "in", "on", "at", "with"]);

/**
 * The unnamed subjects one frame actually shows.
 *
 * Narrowed per frame for the same reason the cast sheet is: the clause ends on
 * an outfit, and an outfit stated into a shot the person is not in is an
 * invitation to draw them there. A subject is free text and prompts vary the
 * wording — "a muscular Black man" against "the muscular Black man" — so this
 * matches on the describing words rather than the phrase.
 *
 * No fallback when nothing matches, unlike the cast sheet: a pinned character
 * has a face to keep consistent and is worth carrying on a maybe, while an
 * unnamed subject the frame never mentions is simply not in it.
 */
export function othersInFrame(
  prompt: string,
  others: Record<string, string>,
): Record<string, string> {
  const haystack = prompt.toLocaleLowerCase();
  return Object.fromEntries(
    Object.entries(others).filter(([subject]) => {
      const words = subject
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word && !SUBJECT_STOP_WORDS.has(word));
      return words.length > 0 && words.every((word) => new RegExp(`\\b${word}\\b`, "u").test(haystack));
    }),
  );
}

/**
 * Vocabulary that only appears when someone is already out of their clothes.
 *
 * Deliberately narrow. Kissing, undressing and stripping are excluded because
 * a scene can contain all three with the clothes still on at the end of it; a
 * false positive here would put someone in the wrong state for every scene
 * after, since a change carries forward.
 */
const UNDRESSED_ACT =
  /\b(?:nude|naked|undressed|topless|bare[-\s](?:breasts?|chest|skin|body)|penetrat\w*|thrust\w*|straddl\w*|riding\s+him|intercourse|fellati\w*|cunnilingus|oral\s+sex|going\s+down\s+on|climax\w*|orgasm\w*|fucking|cock|pussy|nipples?|genital\w*)\b/i;

/**
 * Scenes whose action reads as already undressed while the wardrobe still says
 * otherwise.
 *
 * Advisory only. A stated outfit is appended last and is the strongest single
 * instruction in the prompt, so a sex scene with a robe on the sheet renders
 * the robe — but which scenes those are is a judgement, so this reports rather
 * than decides.
 *
 * A scene that already carries a wardrobe change is skipped. The act is
 * scene-level but the undressing is per character, and this cannot tell which
 * one the act belongs to: in a scene written around a watcher it would go on
 * naming the clothed observer forever. An existing change means a person has
 * already ruled on that scene, and the bulk action skips it for the same
 * reason — so flagging it would offer a fix that does nothing.
 */
export function wardrobeContradictions(
  project: Project,
  scenes: readonly SceneLike[],
  cast: readonly Character[],
): { sceneId: string; sceneNumber: number; title: string; characters: string[] }[] {
  if (cast.length === 0) return [];
  const timeline = wardrobeTimeline(project, scenes, cast);

  return scenes.flatMap((scene) => {
    if (project.wardrobeChanges?.[scene.id]?.length) return [];

    const text = `${scene.visualDescription} ${scene.actionDescription} ${scene.storyBeat}`;
    if (!UNDRESSED_ACT.test(text)) return [];

    const wardrobe = timeline.get(scene.id);
    const dressed = cast.filter((c) => {
      const outfit = wardrobe?.end[c.id];
      return Boolean(outfit) && !isUndressed(outfit!);
    });
    if (dressed.length === 0) return [];

    return [
      {
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        title: scene.title,
        characters: dressed.map((c) => c.name),
      },
    ];
  });
}

type SceneLike = {
  id: string;
  sceneNumber: number;
  title: string;
  visualDescription: string;
  actionDescription: string;
  storyBeat: string;
};

/** Matches the wardrobe states the cast sheet renders as nudity. */
export function isUndressed(wardrobe: string): boolean {
  return /^(?:fully\s+|completely\s+|entirely\s+)?(?:nude|naked|undressed|bare|nothing|none|no\s+clothes|no\s+clothing)\.?$/i.test(
    wardrobe.trim(),
  );
}

/** The project's wardrobe for a character, falling back to the library default. */
export function wardrobeOf(project: Project, character: Character): string | undefined {
  const override = project.characterWardrobe?.[character.id]?.trim();
  return override || character.wardrobe?.trim() || undefined;
}

/**
 * Merge costume changes the Storyboard Artist wrote into the project's map.
 *
 * A name the cast recognises becomes a change for that character; anything else
 * becomes a change for an unnamed subject rather than being discarded, since
 * "the two men" is a perfectly good way to refer to people who were never
 * pinned. Existing entries for a scene are left alone: those were set by a
 * person, and an agent re-run should not quietly overrule them.
 */
export function foldWardrobeChanges(
  project: Project,
  drafts: readonly { id: string; wardrobeChanges?: DraftWardrobeChange[] }[],
  cast: readonly Character[],
): Project {
  const byName = new Map(cast.map((c) => [c.name.trim().toLocaleLowerCase(), c] as const));
  const merged: Record<string, WardrobeChange[]> = { ...(project.wardrobeChanges ?? {}) };
  let added = 0;

  for (const draft of drafts) {
    if (merged[draft.id]?.length) continue;
    const changes = (draft.wardrobeChanges ?? []).flatMap<WardrobeChange>((proposed) => {
      const subject = proposed.character.trim();
      const wardrobe = proposed.newWardrobe.trim();
      if (!subject || !wardrobe) return [];
      const character = byName.get(subject.toLocaleLowerCase());
      const mode = proposed.depictedOnScreen ? ("within" as const) : ("between" as const);
      return [
        character
          ? { characterId: character.id, wardrobe, mode }
          : { subject, wardrobe, mode },
      ];
    });
    if (changes.length) {
      merged[draft.id] = changes;
      added += changes.length;
    }
  }

  if (added === 0) return project;
  return { ...project, wardrobeChanges: merged };
}

type DraftWardrobeChange = {
  character: string;
  newWardrobe: string;
  depictedOnScreen: boolean;
};

/**
 * The cast, re-dressed to reflect every change declared in the drafts so far.
 *
 * Scene cards are written a few at a time and each batch is handed the cast
 * afresh, so without this the batch after a change is still told the original
 * outfit and writes it straight back into the scene — a character undresses in
 * scene 8 and is described in her lingerie again in scene 13. Unnamed subjects
 * come back separately because they have no cast entry to carry the outfit.
 */
export function castWardrobeAfter(
  cast: readonly Character[],
  drafts: readonly { wardrobeChanges?: DraftWardrobeChange[] }[],
): { cast: Character[]; others: Record<string, string> } {
  const idByName = new Map(cast.map((c) => [c.name.trim().toLocaleLowerCase(), c.id] as const));
  const current: Record<string, string> = {};
  const others: Record<string, string> = {};

  for (const draft of drafts) {
    for (const change of draft.wardrobeChanges ?? []) {
      const subject = change.character.trim();
      const wardrobe = change.newWardrobe.trim();
      if (!subject || !wardrobe) continue;
      const id = idByName.get(subject.toLocaleLowerCase());
      if (id) current[id] = wardrobe;
      else others[subject] = wardrobe;
    }
  }

  return {
    cast: cast.map((c) => (current[c.id] ? { ...c, wardrobe: current[c.id] } : c)),
    others,
  };
}

/**
 * A sentence naming the change, for the prompt of the scene that depicts it.
 *
 * Only `within` changes produce one. A `between` change needs no narration:
 * both frames simply show the new outfit.
 */
export function wardrobeChangeClause(
  within: readonly WardrobeChange[],
  cast: readonly Character[],
  startWardrobe: Record<string, string>,
  othersStart: Record<string, string> = {},
): string {
  if (within.length === 0) return "";
  const byId = new Map(cast.map((c) => [c.id, c] as const));
  const sentences = within.flatMap((change) => {
    const name = change.characterId ? byId.get(change.characterId)?.name : change.subject?.trim();
    if (!name) return [];
    const from = change.characterId
      ? startWardrobe[change.characterId]
      : othersStart[change.subject!.trim()];
    return [
      from
        ? `${name} changes out of ${from} and into ${change.wardrobe} during this segment.`
        : `${name} puts on ${change.wardrobe} during this segment.`,
    ];
  });
  return sentences.length ? ` ${sentences.join(" ")}` : "";
}

/**
 * Why a costume change is harder in a continuous take.
 *
 * There is no cut to hide it in, so the garment has to be seen coming off or
 * going on. A `between` change asks for the impossible: the same subject
 * wearing a different outfit across a seam the audience never looks away from.
 */
export function continuousTakeWardrobeWarning(
  project: Project,
  sceneNumber: number,
  changes: readonly WardrobeChange[],
): string | null {
  if (!isContinuousTake(project) || changes.length === 0) return null;
  const between = changes.filter((c) => c.mode === "between");
  if (between.length === 0) {
    return (
      `Scene ${sceneNumber} is part of a continuous take, so the change has to be visible on ` +
      "screen. Give the segment enough time for it and expect several attempts."
    );
  }
  return (
    `Scene ${sceneNumber} is part of a continuous take, so a change that happens between scenes ` +
    "has no cut to hide in — the outfit will appear to swap itself. Depict it within the scene " +
    "instead, or set this project's continuity to cut."
  );
}
