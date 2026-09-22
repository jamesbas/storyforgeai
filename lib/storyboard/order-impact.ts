import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import { seamBreak } from "@/lib/media/seam";
import { DEFAULT_SCENE_CONTINUITY } from "@/lib/types";

/**
 * What changing the running order actually costs.
 *
 * Reordering a storyboard destroys nothing — every frame, seed and LoRA choice
 * is keyed by scene id and follows its scene — but it does invalidate claims
 * other scenes were built on. A clip that opens on its predecessor's last frame
 * is opening on a different picture now; an outfit that was established three
 * scenes earlier may be established three scenes later.
 *
 * This reports those consequences and repairs none of them. The distinction
 * matters: a frame silently re-pointed at a picture that does not exist yet is
 * a worse outcome than a frame the creator was told about and chose to keep.
 *
 * Pure, and computed from the two orders rather than assumed from the shape of
 * the edit, so the dialog and the tests cannot drift apart.
 */

export type ImpactScene = {
  id: string;
  /** The number the scene will carry *after* the change — what the user sees. */
  sceneNumber: number;
  title: string;
};

export type StaleArtifact = "assembly" | "audioPlan" | "animaticPlan";

export type OrderImpact = {
  /**
   * Scenes holding a rendered frame inherited from a neighbour that is no
   * longer their neighbour.
   */
  inheritedFrames: ImpactScene[];
  /**
   * Scenes whose opening prompt was written to match a predecessor that is
   * about to change. These are the scenes an opt-in rewrite would target.
   */
  promptSeams: ImpactScene[];
  /** Scenes whose resolved wardrobe differs between the two running orders. */
  wardrobe: ImpactScene[];
  /** Stored artifacts the change invalidates. */
  staleArtifacts: StaleArtifact[];
  /** Nothing at all is invalidated, so the confirmation can be a plain one. */
  clean: boolean;
};

/** The scene before this one, or undefined at the head of the order. */
function predecessorOf(order: readonly string[], sceneId: string): string | undefined {
  const index = order.indexOf(sceneId);
  return index > 0 ? order[index - 1] : undefined;
}

function wardrobeEquals(a: SceneWardrobe | undefined, b: SceneWardrobe | undefined): boolean {
  if (!a || !b) return a === b;
  // Compared by value: the timeline rebuilds its records on every walk, so
  // identity would report every scene as changed.
  return (
    JSON.stringify([a.start, a.end, a.othersStart, a.othersEnd]) ===
    JSON.stringify([b.start, b.end, b.othersStart, b.othersEnd])
  );
}

/**
 * Compare the storyboard as it stands with the order it is about to be put in.
 *
 * `after` is the full id sequence, and may contain an id that is not in the
 * record yet — that is how an insertion is assessed before the scene exists.
 * Such a scene has no history to invalidate, so it is skipped throughout.
 */
export function orderImpact(
  record: ProjectRecord,
  after: readonly string[],
  cast: readonly Character[],
): OrderImpact {
  const storyboard = record.storyboard;
  if (!storyboard) {
    return {
      inheritedFrames: [],
      promptSeams: [],
      wardrobe: [],
      staleArtifacts: [],
      clean: true,
    };
  }

  const before = storyboard.scenes.map((scene) => scene.id);
  const byId = new Map(storyboard.scenes.map((scene) => [scene.id, scene] as const));
  const continuity = record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY;
  const numberAfter = new Map(after.map((id, index) => [id, index + 1] as const));

  const ref = (scene: Scene): ImpactScene => ({
    id: scene.id,
    sceneNumber: numberAfter.get(scene.id) ?? scene.sceneNumber,
    title: scene.title,
  });

  const inheritedFrames: ImpactScene[] = [];
  const promptSeams: ImpactScene[] = [];

  // Under `cut` nothing inherits, so nothing about a seam can go stale. Saying
  // so silently is the point: a warning that does not apply is how people learn
  // to dismiss the one that does.
  if (continuity !== "cut") {
    // Mirrors `inheritsOpening` in the prompt agent: a scene's opening was
    // written to match its predecessor only where it had one and did not
    // declare a break from it. Evaluated against both orders, because what
    // matters is whether that claim *changed* — a scene that never inherited
    // has nothing a move can invalidate, whichever position it lands in.
    const inherits = (scene: Scene, predecessorId: string | undefined): boolean => {
      const previous = predecessorId ? byId.get(predecessorId) : undefined;
      return previous !== undefined && !seamBreak(previous, scene);
    };

    for (const id of after) {
      const scene = byId.get(id);
      if (!scene) continue; // a scene being inserted has nothing to invalidate

      const was = predecessorOf(before, id);
      const now = predecessorOf(after, id);
      if (was === now) continue;
      if (!inherits(scene, was) && !inherits(scene, now)) continue;

      promptSeams.push(ref(scene));

      const latest = (record.attempts?.[id] ?? []).at(-1);
      if (latest?.startImageInherited) inheritedFrames.push(ref(scene));
    }
  }

  // Wardrobe is resolved by walking the scenes in order, so the only honest way
  // to know whether a move changes an outfit is to walk it both ways.
  const orderedBefore = before
    .map((id) => byId.get(id))
    .filter((scene): scene is Scene => scene !== undefined);
  const orderedAfter = after
    .map((id) => byId.get(id))
    .filter((scene): scene is Scene => scene !== undefined);

  const timelineBefore = wardrobeTimeline(record.project, orderedBefore, cast);
  const timelineAfter = wardrobeTimeline(record.project, orderedAfter, cast);

  const wardrobe: ImpactScene[] = [];
  for (const scene of orderedAfter) {
    if (!wardrobeEquals(timelineBefore.get(scene.id), timelineAfter.get(scene.id))) {
      wardrobe.push(ref(scene));
    }
  }

  const staleArtifacts: StaleArtifact[] = [];
  if (record.assembly) staleArtifacts.push("assembly");
  if (record.audioPlan) staleArtifacts.push("audioPlan");
  if (record.animaticPlan) staleArtifacts.push("animaticPlan");

  return {
    inheritedFrames,
    promptSeams,
    wardrobe,
    staleArtifacts,
    clean:
      inheritedFrames.length === 0 &&
      promptSeams.length === 0 &&
      wardrobe.length === 0 &&
      staleArtifacts.length === 0,
  };
}
