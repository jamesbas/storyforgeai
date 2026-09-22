import { z } from "zod";
import { repository } from "@/lib/db/store";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import { appendHistory, getProjectRecord, regenerateScenesPrompts } from "@/lib/services/project-service";
import { resolveProjectCast } from "@/lib/services/character-service";
import { getQueue } from "@/lib/services/scene-queue";
import { orderImpact, type OrderImpact } from "@/lib/storyboard/order-impact";
import { moveInOrder, withRunningOrder, type MoveDirection } from "@/lib/storyboard/running-order";
import { logEvent } from "@/lib/telemetry";

/**
 * Changing the running order of a storyboard.
 *
 * Kept out of `project-service` for one structural reason: the queue guard
 * needs `scene-queue`, and `scene-queue` already imports `project-service`.
 * Sitting above both leaves the dependency graph acyclic and keeps a file that
 * is already 1700 lines from growing again.
 *
 * The transform itself lives in `lib/storyboard/running-order.ts` and is pure.
 * What belongs here is everything it deliberately does not do: loading,
 * guarding, recording history, persisting, and the opt-in prompt rewrite.
 */

export const moveSceneSchema = z.object({
  direction: z.enum(["up", "down"]),
  /**
   * Rewrite the opening prompts of the scenes this move invalidates.
   *
   * Opt-in and absent by default. A move destroys nothing, so repairing it is
   * a choice; rewriting by default would quietly replace hand-written prompts
   * as a side effect of rearranging the running order.
   */
  rewritePrompts: z.boolean().optional(),
});

export type MoveSceneInput = z.infer<typeof moveSceneSchema>;

export type MoveSceneResult = {
  record: ProjectRecord;
  impact: OrderImpact;
  /** Scenes whose prompts were actually rewritten, in the order they were run. */
  rewrittenScenes: string[];
  /** Set when the reorder succeeded but the opt-in rewrite did not. */
  rewriteError?: string;
};

/**
 * Load the project and work out the order this move would produce.
 *
 * Shared by the preview and the move itself so the dialog cannot describe one
 * outcome while the action performs another.
 */
async function planMove(
  projectId: string,
  sceneId: string,
  direction: MoveDirection,
): Promise<{ record: ProjectRecord; scene: Scene; after: string[] }> {
  const record = await getProjectRecord(projectId);
  const storyboard = record.storyboard;
  if (!storyboard) throw new ValidationError("Generate a storyboard before reordering scenes");

  const scene = storyboard.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);

  const after = moveInOrder(
    storyboard.scenes.map((s) => s.id),
    sceneId,
    direction,
  );
  if (!after) {
    throw new ValidationError(
      direction === "up"
        ? `Scene ${scene.sceneNumber} is already first.`
        : `Scene ${scene.sceneNumber} is already last.`,
    );
  }

  return { record, scene, after };
}

/**
 * What this move would cost, without making it.
 *
 * Read-only, so the confirmation can show real consequences rather than a
 * generic warning — and so the list it shows is the same list the rewrite would
 * act on.
 */
export async function previewSceneMove(
  projectId: string,
  sceneId: string,
  direction: MoveDirection,
): Promise<OrderImpact> {
  const { record, after } = await planMove(projectId, sceneId, direction);
  return orderImpact(record, after, await resolveProjectCast(record.project));
}

/**
 * Move one scene a single position and persist the result.
 *
 * Nothing keyed by scene id is read or written: ids do not change, so every
 * rendered frame, seed, LoRA stack, wardrobe change and audio cue follows its
 * scene without being touched.
 */
export async function moveScene(
  projectId: string,
  sceneId: string,
  raw: unknown,
): Promise<MoveSceneResult> {
  const input = moveSceneSchema.parse(raw);
  const { record, scene, after } = await planMove(projectId, sceneId, input.direction);

  // Renumbering under a live drainer would leave queue entries holding a scene
  // number that no longer names the scene they were built for.
  if (getQueue(projectId).active) {
    throw new PrerequisiteError(
      "Scenes cannot be reordered while a generation queue is running. " +
        "Wait for it to finish, or cancel it first.",
    );
  }

  const cast = await resolveProjectCast(record.project);
  const impact = orderImpact(record, after, cast);

  const reordered = withRunningOrder(record, after);
  const to = after.indexOf(sceneId) + 1;
  const updated: ProjectRecord = {
    ...reordered,
    project: { ...reordered.project, updatedAt: new Date().toISOString() },
    history: appendHistory(
      record,
      "scene.moved",
      `Scene ${scene.sceneNumber} → position ${to}`,
    ),
  };

  await repository.update(projectId, updated);
  logEvent("project.updated", {
    id: projectId,
    change: "scene_moved",
    sceneId,
    direction: input.direction,
    from: scene.sceneNumber,
    to,
  });

  const targets = impact.promptSeams.map((s) => s.id);
  if (!input.rewritePrompts || !targets.length) {
    return { record: updated, impact, rewrittenScenes: [] };
  }

  // Deliberately after the reorder is persisted. The prompt agents walk the
  // scenes in running order to match each opening to its predecessor, so a
  // rewrite run before this point would match the neighbours the move just
  // replaced — which is the whole thing it is meant to fix.
  try {
    const rewritten = await regenerateScenesPrompts(projectId, targets, { passes: ["image"] });
    return { record: rewritten, impact, rewrittenScenes: targets };
  } catch (err) {
    // The reorder is a committed fact. Undoing it because an optional extra
    // failed would lose the thing that did work.
    const message = err instanceof Error ? err.message : "Rewriting the prompts failed";
    logEvent("scene.move_rewrite_failed", { id: projectId, sceneId, detail: message });
    return { record: updated, impact, rewrittenScenes: [], rewriteError: message };
  }
}
