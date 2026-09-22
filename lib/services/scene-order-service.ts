import { z } from "zod";
import { repository } from "@/lib/db/store";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import type { ProjectRecord, Scene, SceneDraft } from "@/lib/schemas/storyboard";
import { insertSceneSchema } from "@/lib/schemas/storyboard";
import { appendHistory, getProjectRecord, regenerateScenesPrompts } from "@/lib/services/project-service";
import { resolveProjectCast } from "@/lib/services/character-service";
import { getQueue } from "@/lib/services/scene-queue";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { mintSceneId, newSceneDraft } from "@/lib/storyboard/insert-scene";
import { orderImpact, type OrderImpact } from "@/lib/storyboard/order-impact";
import {
  insertInOrder,
  moveInOrder,
  withRunningOrder,
  type MoveDirection,
} from "@/lib/storyboard/running-order";
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

/** The id used to stand in for the new scene while its cost is being assessed. */
const PROSPECTIVE_SCENE = "__inserted__";

export type InsertSceneResult = {
  record: ProjectRecord;
  sceneId: string;
  sceneNumber: number;
  impact: OrderImpact;
  /** The scene that now follows the new one, if any. */
  followerSceneId?: string;
  /** Its opening frame was carried over from what is no longer its predecessor. */
  followerFrameStale: boolean;
};

/** Resolve the anchor and the order the insertion would produce. */
async function planInsert(
  projectId: string,
  anchorSceneId: string,
  side: "before" | "after",
  newSceneId: string,
): Promise<{ record: ProjectRecord; order: string[] }> {
  const record = await getProjectRecord(projectId);
  const storyboard = record.storyboard;
  if (!storyboard) throw new ValidationError("Generate a storyboard before adding scenes");

  const order = insertInOrder(
    storyboard.scenes.map((s) => s.id),
    newSceneId,
    anchorSceneId,
    side,
  );
  if (!order) throw new NotFoundError(`Scene ${anchorSceneId} not found`);

  return { record, order };
}

/**
 * What inserting here would cost, without inserting anything.
 *
 * The prospective scene is named by a placeholder id. `orderImpact` skips ids
 * it cannot find in the record, which is exactly right: a scene that does not
 * exist yet has no rendered frame and no written prompt to invalidate.
 */
export async function previewSceneInsert(
  projectId: string,
  anchorSceneId: string,
  side: "before" | "after",
): Promise<OrderImpact> {
  const { record, order } = await planInsert(projectId, anchorSceneId, side, PROSPECTIVE_SCENE);
  return orderImpact(record, order, await resolveProjectCast(record.project));
}

/**
 * Add a scene to an existing storyboard.
 *
 * The piece gets longer rather than the other scenes getting shorter: every
 * scene is `segmentSeconds` long and stays that way, so the project's totals
 * grow by one segment. `finalTrimSeconds` is deliberately untouched — the
 * creator asked for a longer piece, so the overshoot from the original
 * rounding is still all the trim represents.
 */
export async function insertScene(
  projectId: string,
  raw: unknown,
): Promise<InsertSceneResult> {
  const input = insertSceneSchema.parse(raw);

  // Minted first so the rest of the transform, and the prompt pass, can key
  // off it. Independent of position, which is what lets renumbering leave
  // every id-keyed structure alone.
  const sceneId = mintSceneId(projectId);
  const { record, order } = await planInsert(
    projectId,
    input.anchorSceneId,
    input.side,
    sceneId,
  );

  if (getQueue(projectId).active) {
    throw new PrerequisiteError(
      "Scenes cannot be added while a generation queue is running. " +
        "Wait for it to finish, or cancel it first.",
    );
  }

  const storyboard = record.storyboard!;
  const cast = await resolveProjectCast(record.project);
  const impact = orderImpact(record, order, cast);

  const followerSceneId = order[order.indexOf(sceneId) + 1];
  const followerFrameStale = Boolean(
    followerSceneId && (record.attempts?.[followerSceneId] ?? []).at(-1)?.startImageInherited,
  );

  // Drafts in the order they will run, because the prompt pass walks them in
  // sequence: the follower's opening can only be matched to the new scene's
  // end frame if the new scene is written first, and that falls out of the
  // array order rather than being arranged separately.
  const draft = newSceneDraft(record.project, input.card, sceneId);
  const byId = new Map<string, SceneDraft>(
    storyboard.scenes.map(({ prompts: _prompts, ...rest }) => [rest.id, rest] as const),
  );
  byId.set(sceneId, draft);
  const drafts = order.map((id) => byId.get(id)!);

  // Only the new scene, and the follower when the creator asked for it. Every
  // other scene keeps its stored prompts while still advancing the seam and the
  // wardrobe walk, which is what makes this one call rather than two.
  const only = new Set([sceneId]);
  if (input.rewriteFollower && followerSceneId) only.add(followerSceneId);

  const scenes: Scene[] = await attachScenePrompts(
    record.project,
    drafts,
    // Null writes the deterministic prompts, which cost no model call and no
    // GPU time. A scene needs a complete `prompts` object to parse at all, so
    // this is the floor rather than an optimisation.
    input.writePrompts ? getPlanningProvider() : null,
    {
      cast,
      visualBible: storyboard.visualBible,
      plans: {
        worldBible: record.worldBible,
        directorialPlan: record.directorialPlan,
        cinematographyPlan: record.cinematographyPlan,
        artDirectionPlan: record.artDirectionPlan,
      },
      only,
      existing: Object.fromEntries(storyboard.scenes.map((s) => [s.id, s.prompts] as const)),
    },
  );

  const normalised = withRunningOrder(record, order, {
    scenes,
    // The plans were numbered against the board as it was, so the remap has to
    // be computed from that and not from the array the new scene is already in.
    previousOrder: storyboard.scenes.map((s) => s.id),
  });

  const sceneNumber = order.indexOf(sceneId) + 1;
  const anchor = storyboard.scenes.find((s) => s.id === input.anchorSceneId)!;
  const updated: ProjectRecord = {
    ...normalised,
    project: {
      ...normalised.project,
      segmentCount: normalised.project.segmentCount + 1,
      generatedDurationSeconds:
        normalised.project.generatedDurationSeconds + normalised.project.segmentSeconds,
      requestedDurationSeconds:
        normalised.project.requestedDurationSeconds + normalised.project.segmentSeconds,
      updatedAt: new Date().toISOString(),
    },
    history: appendHistory(
      record,
      "scene.inserted",
      `Scene ${sceneNumber} — ${input.side} scene ${anchor.sceneNumber}`,
    ),
  };

  await repository.update(projectId, updated);
  logEvent("scene.inserted", {
    id: projectId,
    sceneId,
    sceneNumber,
    totalScenes: updated.storyboard!.scenes.length,
    promptsWritten: input.writePrompts ? "model" : "deterministic",
  });
  if (followerFrameStale) {
    logEvent("scene.insert_follower_stale", { id: projectId, sceneId, followerSceneId });
  }

  return {
    record: updated,
    sceneId,
    sceneNumber,
    impact,
    followerSceneId,
    followerFrameStale,
  };
}
