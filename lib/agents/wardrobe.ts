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

  const byId = new Map(cast.map((c) => [c.id, c] as const));
  const timeline = new Map<string, SceneWardrobe>();

  for (const scene of scenes) {
    const changes = (project.wardrobeChanges?.[scene.id] ?? []).filter((c) => byId.has(c.characterId));
    const start = { ...current };
    const within: WardrobeChange[] = [];

    for (const change of changes) {
      const wardrobe = change.wardrobe.trim();
      if (!wardrobe) continue;
      if (change.mode === "within") {
        within.push(change);
      } else {
        // Already changed by the time the scene opens, so both frames wear it.
        start[change.characterId] = wardrobe;
      }
      current[change.characterId] = wardrobe;
    }

    timeline.set(scene.id, { start, end: { ...current }, within });
  }

  return timeline;
}

/** The project's wardrobe for a character, falling back to the library default. */
export function wardrobeOf(project: Project, character: Character): string | undefined {
  const override = project.characterWardrobe?.[character.id]?.trim();
  return override || character.wardrobe?.trim() || undefined;
}

/**
 * Merge costume changes the Storyboard Artist wrote into the project's map.
 *
 * The agent names characters, having never seen an id, so a change that does
 * not match a cast member by name is dropped rather than guessed at. Existing
 * entries for a scene are left alone: those were set by a person, and an agent
 * re-run should not quietly overrule them.
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
    const changes = (draft.wardrobeChanges ?? []).flatMap((proposed) => {
      const character = byName.get(proposed.character.trim().toLocaleLowerCase());
      const wardrobe = proposed.newWardrobe.trim();
      if (!character || !wardrobe) return [];
      return [
        {
          characterId: character.id,
          wardrobe,
          mode: proposed.depictedOnScreen ? ("within" as const) : ("between" as const),
        },
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
 * A sentence naming the change, for the prompt of the scene that depicts it.
 *
 * Only `within` changes produce one. A `between` change needs no narration:
 * both frames simply show the new outfit.
 */
export function wardrobeChangeClause(
  within: readonly WardrobeChange[],
  cast: readonly Character[],
  startWardrobe: Record<string, string>,
): string {
  if (within.length === 0) return "";
  const byId = new Map(cast.map((c) => [c.id, c] as const));
  const sentences = within.flatMap((change) => {
    const name = byId.get(change.characterId)?.name;
    if (!name) return [];
    const from = startWardrobe[change.characterId];
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
