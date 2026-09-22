import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

/**
 * The running order of a storyboard, and everything that has to move with it.
 *
 * Both reordering a scene and inserting one reduce to the same thing: produce
 * the new sequence of scene ids, then normalise the record against it. Keeping
 * that in one pure module is what stops two features growing two renumbering
 * implementations that disagree at the edges.
 *
 * Nothing here performs I/O, and nothing here touches a structure keyed by
 * scene id — `attempts`, `previews`, `sceneSeeds`, `sceneLoras`,
 * `sceneEndFrameRefs`, `wardrobeChanges`, audio cues and `executions` are all
 * invariant under a reorder precisely because ids never change. An
 * implementation that finds itself needing to rewrite one of them has
 * abandoned this model rather than extended it.
 */

export type MoveDirection = "up" | "down";

/** What a running order needs from the project to derive the clock. */
export type OrderTiming = {
  segmentSeconds: number;
  finalTrimSeconds: number;
};

/**
 * The id sequence after moving one scene a single position.
 *
 * Returns `null` at the boundaries — moving the first scene up, or the last
 * down — so the caller refuses rather than silently returning the order it was
 * given. A no-op that reports success is how a dead button gets shipped without
 * anyone noticing it does nothing.
 */
export function moveInOrder(
  ids: readonly string[],
  sceneId: string,
  direction: MoveDirection,
): string[] | null {
  const from = ids.indexOf(sceneId);
  if (from < 0) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return null;

  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * The id sequence after inserting a new scene beside an anchor.
 *
 * `before` and `after` are two labels for one operation — inserting after
 * scene 3 and before scene 4 name the same gap — so both resolve here to a
 * single index rather than travelling as separate code paths.
 */
export function insertInOrder(
  ids: readonly string[],
  newSceneId: string,
  anchorSceneId: string,
  side: "before" | "after",
): string[] | null {
  const anchor = ids.indexOf(anchorSceneId);
  if (anchor < 0 || ids.includes(newSceneId)) return null;

  const next = [...ids];
  next.splice(side === "before" ? anchor : anchor + 1, 0, newSceneId);
  return next;
}

/**
 * Reorder, renumber and retime the scenes against an id sequence.
 *
 * The derived fields are computed exactly as `withDerivedTiming` computes them
 * for a freshly generated storyboard, so a reordered board is indistinguishable
 * from a generated one of the same shape. The model owns the creative content;
 * position owns the clock.
 */
export function applyRunningOrder(
  scenes: readonly Scene[],
  order: readonly string[],
  timing: OrderTiming,
): Scene[] {
  if (order.length !== scenes.length) {
    throw new Error(
      `Running order has ${order.length} entries for a storyboard of ${scenes.length} scenes.`,
    );
  }

  const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
  const seen = new Set<string>();
  const ordered = order.map((id) => {
    const scene = byId.get(id);
    if (!scene) throw new Error(`Running order names unknown scene ${id}.`);
    if (seen.has(id)) throw new Error(`Running order names scene ${id} twice.`);
    seen.add(id);
    return scene;
  });

  const last = ordered.length - 1;
  return ordered.map((scene, index) => {
    const startTimeSeconds = index * timing.segmentSeconds;
    return {
      ...scene,
      sceneNumber: index + 1,
      startTimeSeconds,
      endTimeSeconds: startTimeSeconds + timing.segmentSeconds,
      targetDurationSeconds: timing.segmentSeconds,
      // The trim belongs to the last *position*, not to the scene that happened
      // to be there before. Left on a scene now in the middle it would cut the
      // piece in half.
      trimAtEndSeconds:
        index === last && timing.finalTrimSeconds > 0
          ? timing.segmentSeconds - timing.finalTrimSeconds
          : undefined,
    };
  });
}

/**
 * Old scene number to new scene number, for every scene that existed before.
 *
 * A scene present only in the new order — an insertion — is deliberately absent
 * from the mapping. Nothing then maps onto its number, which leaves a real gap
 * in the number-keyed plans; `segmentsMissingFrom` already reports that, and
 * inventing an entry to fill it would hide the one honest signal there is.
 */
export function renumberingFrom(
  before: readonly string[],
  after: readonly string[],
): Map<number, number> {
  const from = new Map(before.map((id, index) => [id, index + 1] as const));
  const mapping = new Map<number, number>();
  after.forEach((id, index) => {
    const was = from.get(id);
    if (was !== undefined) mapping.set(was, index + 1);
  });
  return mapping;
}

/**
 * A plan key that names a scene by number, in any of the forms `sceneEntry`
 * accepts: `"3"`, `"scene 3"`, `"Scene 3"`, and the same with stray whitespace.
 *
 * The surrounding text is captured rather than normalised so a remapped key
 * keeps the shape the model wrote it in. Rewriting `"Scene 3"` as `"4"` would
 * resolve identically and read as though something else had edited the plan.
 */
const NUMBER_KEY = /^(\s*(?:scene\s+)?)(\d+)(\s*)$/i;

/**
 * Shift number-keyed plan entries so each keeps describing the scene it was
 * written for.
 *
 * `directorialPlan.sceneIntent` and `cinematographyPlan.sceneShotPlans` are
 * `z.record(z.string())` resolved by `sceneEntry`, which accepts a scene id, a
 * bare number, or `"scene N"`. Only the number forms move: a key that resolves
 * to an **id** already names the right scene whatever its position, and a key
 * that resolves to nothing is not ours to interpret.
 *
 * The whole map is rebuilt in one pass from the original rather than edited in
 * place, because the mapping is a permutation and not a shift — moving scene 4
 * to 5 also moves 5 to 4, and rewriting them one at a time collapses both onto
 * whichever was written second.
 *
 * `dropped` names old numbers whose scene has gone. Without it a deletion
 * leaves the departed scene's entry sitting on a number that now belongs to
 * somebody else — sometimes overwritten by the shift and sometimes not, which
 * is worse than either, because it depends on the shape of the keys the model
 * happened to write.
 */
export function remapNumberKeys(
  map: Record<string, string>,
  renumbering: ReadonlyMap<number, number>,
  dropped: ReadonlySet<number> = new Set(),
): Record<string, string> {
  let changed = false;
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(map)) {
    const match = NUMBER_KEY.exec(key);
    const was = match ? Number(match[2]) : undefined;

    if (was !== undefined && dropped.has(was)) {
      changed = true;
      continue;
    }

    const to = was === undefined ? undefined : renumbering.get(was);
    if (match && to !== undefined && to !== was) {
      next[`${match[1]}${to}${match[3]}`] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  }

  // Returning the original when nothing moved keeps a record byte-identical
  // through a no-op, which is what the "nothing else changed" tests rest on.
  return changed ? next : map;
}

/**
 * The record as it stands once the storyboard is put into a new running order.
 *
 * Pure: it returns the next record and writes nothing. The caller owns loading,
 * the queue guard, history and persistence — this owns only the question of
 * what a reorder means.
 *
 * `options` exists for insertion, which changes the cast of scenes as well as
 * their order: `scenes` supplies the new set, and `previousOrder` the numbering
 * the plans were written against. Both default to what is on the record, which
 * is the plain reorder case.
 */
export function withRunningOrder(
  record: ProjectRecord,
  order: readonly string[],
  options: { scenes?: readonly Scene[]; previousOrder?: readonly string[] } = {},
): ProjectRecord {
  const storyboard = record.storyboard;
  if (!storyboard) throw new Error("A storyboard is required before it can be reordered.");

  const source = options.scenes ?? storyboard.scenes;
  const before = options.previousOrder ?? storyboard.scenes.map((scene) => scene.id);
  const scenes = applyRunningOrder(source, order, {
    segmentSeconds: record.project.segmentSeconds,
    finalTrimSeconds: record.project.finalTrimSeconds,
  });
  const renumbering = renumberingFrom(before, order);

  // Numbers whose scene is no longer on the board. Empty for a move or an
  // insertion; a deletion is the only thing that produces one.
  const remaining = new Set(order);
  const dropped = new Set<number>();
  before.forEach((id, index) => {
    if (!remaining.has(id)) dropped.add(index + 1);
  });

  return {
    ...record,
    storyboard: { ...storyboard, scenes },
    ...(record.directorialPlan
      ? {
          directorialPlan: {
            ...record.directorialPlan,
            sceneIntent: remapNumberKeys(
              record.directorialPlan.sceneIntent,
              renumbering,
              dropped,
            ),
          },
        }
      : {}),
    ...(record.cinematographyPlan
      ? {
          cinematographyPlan: {
            ...record.cinematographyPlan,
            sceneShotPlans: remapNumberKeys(
              record.cinematographyPlan.sceneShotPlans,
              renumbering,
              dropped,
            ),
          },
        }
      : {}),
  };
}
