import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import { scheduleStore } from "@/lib/db/schedule-store";
import { redactDetail } from "@/lib/schemas/provenance";
import {
  MAX_QUEUED_ITEMS,
  MAX_REASON_CHARS,
  REQUEUEABLE_ITEM_STATES,
  RUN_TYPE_LABELS,
  editScheduleItemSchema,
  isFinishedItem,
  itemLabel,
  newScheduleItemSchema,
  type ItemPreparation,
  type ItemState,
  type ItemSummary,
  type NewScheduleItem,
  type RunSchedule,
  type RunType,
  type ScheduleItem,
  type ScheduleOptions,
  type ScheduleScope,
} from "@/lib/schemas/schedule";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { isActive, type Task } from "@/lib/schemas/tasks";
import { generationStages } from "@/lib/types";
import type { AgentProgress } from "@/lib/agents/types";
import { getProjectRecord } from "@/lib/services/project-service";
import { chosenAttempt } from "@/lib/services/media-service";
import { repository } from "@/lib/db/store";
import { cancelCanvasRun, enqueueCanvasRun, getCanvasQueue } from "@/lib/services/canvas-queue";
import {
  cancelQueue,
  clearFinished,
  enqueueKeyframeRerun,
  enqueueSceneRun,
  getQueue,
  missingKeyframeSceneIds,
  videoRerunScope,
  type PhaseProgress,
} from "@/lib/services/scene-queue";
import { cancelDurableCanvasRun, enqueueDurableCanvasRun } from "@/lib/services/canvas-task-queue";
import { cancelDurableSceneBatch, enqueueDurableSceneBatch } from "@/lib/services/scene-task-queue";
import { listTasks } from "@/lib/tasks/task-service";
import { getWangpStatus } from "@/lib/services/wangp-service";
import { getLlmRuntimeStatus, loadPlanningModel } from "@/lib/services/llm-runtime-service";
import { describeBusy, isGenerationBusy } from "@/lib/services/generation-busy";
import { restartWangp, wangpRestartAvailable } from "@/lib/services/wangp-restart-service";
import {
  schedulerRuntime,
  type PreparingPhase,
  type SchedulerCurrent,
} from "@/lib/services/scheduler-state";

/**
 * The project run scheduler: a thin sequencer above the canvas and scene queues.
 *
 * It never runs a unit of work itself. It decides when the next run may begin —
 * after whatever holds the GPU has finished — and then drives exactly the
 * service the run's own button would, so a scheduled item and a hand-started
 * one produce the same result.
 *
 * The plan lives on disk (`run-schedule.json`); the worker lives in memory,
 * pinned to `globalThis`, and exists only while the schedule is `running`. An
 * idle, paused or completed schedule holds no timers and does no work (FR-10).
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const timing = { followMs: config.scheduler.followMs, settleMs: config.scheduler.settleMs };

/** Test seam. */
export function setSchedulerTiming(next: Partial<typeof timing>): void {
  Object.assign(timing, next);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const now = () => new Date().toISOString();
const store = () => scheduleStore();
const cap = (text: string | undefined) => redactDetail(text, MAX_REASON_CHARS);

// ---------------------------------------------------------------------------
// Validation (FR-6, FR-7)
// ---------------------------------------------------------------------------

async function findRecord(projectId: string): Promise<ProjectRecord | null> {
  try {
    return await getProjectRecord(projectId);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** Problems no queue position can fix: the item cannot run on this project. */
function intrinsicProblem(
  item: { runType: RunType; options: ScheduleOptions },
  record: ProjectRecord,
): string | null {
  const mode = record.project.generationMode;
  const stages = generationStages(mode);
  if (item.runType === "keyframes" && !stages.keyframes) {
    return "This project's generation mode is Storyboard only, so it renders no keyframes.";
  }
  if (item.runType === "video" && !stages.video) {
    return mode === "storyboard_only"
      ? "This project's generation mode is Storyboard only, so it renders no clips."
      : "This project's generation mode is Keyframes only, so it renders no clips.";
  }
  if (config.flags.durableTasks) {
    if (item.runType === "keyframes") {
      return "Keyframe-only runs are not available with durable tasks yet.";
    }
    if (item.runType === "video" && item.options.redoFinished) {
      return "Redoing finished scenes is not available with durable tasks yet.";
    }
  }
  return null;
}

const STORYBOARD_AHEAD: readonly ItemState[] = ["queued", "running"];

/** Problems that depend on where the item sits in the queue. */
function orderingProblem(
  item: ScheduleItem,
  earlier: readonly ScheduleItem[],
  hasStoryboard: boolean,
): string | null {
  if (item.runType === "storyboard") return null;
  const storyboardAhead = earlier.some(
    (other) =>
      other.projectId === item.projectId &&
      other.runType === "storyboard" &&
      STORYBOARD_AHEAD.includes(other.state),
  );
  if (item.scope.mode === "selected" && storyboardAhead) {
    return "Picked scenes can't follow a Storyboard run for the same project, which replaces the scenes. Move this item or change it to All scenes.";
  }
  if (!hasStoryboard && !storyboardAhead) {
    return "This project has no storyboard yet. Put a Storyboard item for it earlier in the queue.";
  }
  return null;
}

/** Recompute `queued` / `invalid` for every waiting item, in place. */
function applyOrdering(draft: RunSchedule, storyboards: ReadonlyMap<string, boolean>): boolean {
  let changed = false;
  draft.items.forEach((item, index) => {
    if (item.state !== "queued" && item.state !== "invalid") return;
    const problem = orderingProblem(
      item,
      draft.items.slice(0, index),
      storyboards.get(item.projectId) ?? false,
    );
    const nextState: ItemState = problem ? "invalid" : "queued";
    const nextReason = problem ?? undefined;
    if (item.state !== nextState || item.reason !== nextReason) changed = true;
    item.state = nextState;
    item.reason = nextReason;
  });
  return changed;
}

async function storyboardMap(items: readonly ScheduleItem[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(items.map((item) => item.projectId))];
  const map = new Map<string, boolean>();
  for (const id of ids) map.set(id, Boolean((await findRecord(id))?.storyboard));
  return map;
}

function pruneHistory(draft: RunSchedule): void {
  const finished = draft.items.filter((item) => isFinishedItem(item.state));
  const excess = finished.length - config.scheduler.historyLimit;
  if (excess <= 0) return;
  const drop = new Set(
    [...finished]
      .sort((a, b) => (a.finishedAt ?? a.addedAt).localeCompare(b.finishedAt ?? b.addedAt))
      .slice(0, excess)
      .map((item) => item.id),
  );
  draft.items = draft.items.filter((item) => !drop.has(item.id));
}

/**
 * Change the schedule under the store's lock.
 *
 * `revision` is what the caller last read: two browser tabs must not reorder
 * over each other, so a stale one is refused rather than merged.
 */
async function mutate<T>(
  revision: number | undefined,
  fn: (draft: RunSchedule) => T | Promise<T>,
): Promise<{ schedule: RunSchedule; result: T }> {
  return store().mutate(async (draft) => {
    if (revision !== undefined && revision !== draft.revision) {
      throw new ConflictError("The schedule changed since you last loaded it. Review it and try again.", {
        staleRevision: true,
      });
    }
    const result = await fn(draft);
    pruneHistory(draft);
    return result;
  });
}

function requireRevision(revision: unknown): number {
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new ValidationError("Include the schedule revision you last read.");
  }
  return revision;
}

function normaliseOptions(runType: RunType, scope: { mode: ScheduleScope["mode"] }, options: ScheduleOptions): ScheduleOptions {
  if (runType === "keyframes") {
    return scope.mode === "all" ? { keyframes: options.keyframes ?? "missing" } : {};
  }
  if (runType === "video") return { redoFinished: Boolean(options.redoFinished) };
  return {};
}

function buildScope(
  runType: RunType,
  input: NewScheduleItem["scope"],
  record: ProjectRecord,
): ScheduleScope {
  if (input.mode === "all" || runType === "storyboard") return { mode: "all" };
  const scenes = record.storyboard?.scenes ?? [];
  if (!scenes.length) {
    throw new ValidationError("Picking scenes needs a storyboard. Use All scenes instead.");
  }
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const unknown = input.sceneIds.find((id) => !byId.has(id));
  if (unknown) throw new ValidationError(`Scene ${unknown} is not in this project.`);
  const picked = [...new Set(input.sceneIds)]
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  return {
    mode: "selected",
    sceneIds: picked.map((scene) => scene.id),
    sceneNumbers: picked.map((scene) => scene.sceneNumber),
    sceneTitles: picked.map((scene) => scene.title.slice(0, 200)),
  };
}

function freshItem(
  fields: Pick<ScheduleItem, "projectId" | "projectTitle" | "runType" | "scope" | "options">,
): ScheduleItem {
  return {
    id: randomUUID(),
    projectId: fields.projectId,
    projectTitle: fields.projectTitle.slice(0, 300),
    runType: fields.runType,
    scope: structuredClone(fields.scope),
    options: structuredClone(fields.options),
    state: "queued",
    addedAt: now(),
  };
}

function waitingCount(schedule: RunSchedule): number {
  return schedule.items.filter((item) => item.state === "queued" || item.state === "invalid").length;
}

function assertRoom(schedule: RunSchedule): void {
  if (waitingCount(schedule) >= MAX_QUEUED_ITEMS) {
    throw new ValidationError(`The queue holds at most ${MAX_QUEUED_ITEMS} waiting items.`);
  }
}

function findItem(draft: RunSchedule, itemId: string): ScheduleItem {
  const item = draft.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new NotFoundError("That schedule item no longer exists.");
  return item;
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

export async function addScheduleItem(raw: unknown, revision: unknown): Promise<{ item: ScheduleItem; schedule: RunSchedule }> {
  const expected = requireRevision(revision);
  const input = newScheduleItemSchema.parse(raw);
  const record = await getProjectRecord(input.projectId);
  const options = normaliseOptions(input.runType, input.scope, input.options);
  const problem = intrinsicProblem({ runType: input.runType, options }, record);
  if (problem) throw new ValidationError(problem);
  const scope = buildScope(input.runType, input.scope, record);

  const { schedule, result } = await mutate(expected, async (draft) => {
    assertRoom(draft);
    const item = freshItem({
      projectId: record.project.id,
      projectTitle: record.project.title,
      runType: input.runType,
      scope,
      options,
    });
    draft.items.push(item);
    applyOrdering(draft, await storyboardMap(draft.items));
    return item.id;
  });
  return { item: findItem(schedule, result), schedule };
}

export async function editScheduleItem(itemId: string, raw: unknown, revision: unknown): Promise<RunSchedule> {
  const expected = requireRevision(revision);
  const patch = editScheduleItemSchema.parse(raw);
  const current = findItem(await store().read(), itemId);
  if (current.state !== "queued" && current.state !== "invalid") {
    throw new ValidationError("Only waiting items can be edited.");
  }
  const record = await getProjectRecord(current.projectId);
  const scope = patch.scope ? buildScope(current.runType, patch.scope, record) : current.scope;
  const options = normaliseOptions(current.runType, scope, patch.options ?? current.options);
  const problem = intrinsicProblem({ runType: current.runType, options }, record);
  if (problem) throw new ValidationError(problem);

  const { schedule } = await mutate(expected, async (draft) => {
    const item = findItem(draft, itemId);
    if (item.state !== "queued" && item.state !== "invalid") {
      throw new ValidationError("Only waiting items can be edited.");
    }
    item.scope = scope;
    item.options = options;
    item.projectTitle = record.project.title;
    applyOrdering(draft, await storyboardMap(draft.items));
  });
  return schedule;
}

export async function removeScheduleItem(itemId: string, revision: unknown): Promise<RunSchedule> {
  const { schedule } = await mutate(requireRevision(revision), async (draft) => {
    const item = findItem(draft, itemId);
    if (item.state === "running") throw new ValidationError("The running item can't be removed. Use Cancel current item.");
    draft.items = draft.items.filter((candidate) => candidate.id !== itemId);
    applyOrdering(draft, await storyboardMap(draft.items));
  });
  return schedule;
}

export type ItemAction = "moveUp" | "moveDown" | "duplicate" | "requeue";

export async function scheduleItemAction(itemId: string, action: unknown, revision: unknown): Promise<RunSchedule> {
  const expected = requireRevision(revision);
  if (action !== "moveUp" && action !== "moveDown" && action !== "duplicate" && action !== "requeue") {
    throw new ValidationError("Unknown item action.");
  }

  // A copy re-runs the project as it is now, so it must still be allowed to.
  let title: string | undefined;
  if (action === "duplicate" || action === "requeue") {
    const original = findItem(await store().read(), itemId);
    const record = await getProjectRecord(original.projectId);
    const problem = intrinsicProblem(original, record);
    if (problem) throw new ValidationError(problem);
    title = record.project.title;
  }

  const { schedule } = await mutate(expected, async (draft) => {
    const index = draft.items.findIndex((candidate) => candidate.id === itemId);
    const item = draft.items[index];
    if (!item) throw new NotFoundError("That schedule item no longer exists.");

    if (action === "moveUp" || action === "moveDown") {
      // Step over finished rows: they are history, shown apart from the queue,
      // and swapping with one would look to the operator like nothing happened.
      const step = action === "moveUp" ? -1 : 1;
      let target = index + step;
      while (draft.items[target] && isFinishedItem(draft.items[target]!.state)) target += step;
      const neighbour = draft.items[target];
      if (!neighbour) return;
      if (item.state === "running" || neighbour.state === "running") {
        throw new ValidationError("The running item can't be moved.");
      }
      draft.items[target] = item;
      draft.items[index] = neighbour;
    } else if (action === "duplicate") {
      assertRoom(draft);
      draft.items.splice(index + 1, 0, freshItem({ ...item, projectTitle: title ?? item.projectTitle }));
    } else {
      if (!REQUEUEABLE_ITEM_STATES.includes(item.state)) {
        throw new ValidationError("Only finished items that did not fully complete can be requeued.");
      }
      assertRoom(draft);
      draft.items.push(freshItem({ ...item, projectTitle: title ?? item.projectTitle }));
    }
    applyOrdering(draft, await storyboardMap(draft.items));
  });
  return schedule;
}

// ---------------------------------------------------------------------------
// Schedule actions
// ---------------------------------------------------------------------------

export type ScheduleAction = "start" | "pause" | "resume" | "cancelCurrent" | "clearFinished";

function assertStartable(draft: RunSchedule): void {
  const invalid = draft.items.find((item) => item.state === "invalid");
  if (invalid) {
    throw new ValidationError(`Fix the invalid item first: ${itemLabel(invalid)}. ${invalid.reason ?? ""}`.trim());
  }
  if (!draft.items.some((item) => item.state === "queued")) {
    throw new ValidationError("Add an item to the queue first.");
  }
}

export async function scheduleAction(action: unknown, revision: unknown): Promise<RunSchedule> {
  switch (action) {
    case "start":
    case "resume": {
      const { schedule } = await mutate(requireRevision(revision), async (draft) => {
        const wanted = action === "start" ? ["idle", "completed"] : ["paused"];
        if (!wanted.includes(draft.state)) {
          throw new ValidationError(
            action === "start" ? "The schedule is already started." : "The schedule is not paused.",
          );
        }
        applyOrdering(draft, await storyboardMap(draft.items));
        assertStartable(draft);
        draft.state = "running";
        if (action === "start") draft.startedAt = now();
        draft.restartNotice = null;
      });
      logEvent(action === "start" ? "scheduler.started" : "scheduler.resumed", {
        queued: schedule.items.filter((item) => item.state === "queued").length,
      });
      void runLoop();
      return schedule;
    }
    case "pause": {
      const { schedule } = await mutate(requireRevision(revision), (draft) => {
        if (draft.state !== "running") throw new ValidationError("The schedule is not running.");
        draft.state = "paused";
      });
      logEvent("scheduler.paused", { itemRunning: Boolean(schedulerRuntime().current) });
      return schedule;
    }
    case "cancelCurrent": {
      await cancelCurrentItem();
      return store().read();
    }
    case "clearFinished": {
      const { schedule } = await mutate(requireRevision(revision), (draft) => {
        draft.items = draft.items.filter((item) => !isFinishedItem(item.state));
        if (draft.state === "completed") draft.state = "idle";
        draft.restartNotice = null;
      });
      return schedule;
    }
    default:
      throw new ValidationError("Unknown schedule action.");
  }
}

/**
 * Abandon the running item's pending units through the existing cancel.
 *
 * The unit already in flight still finishes, exactly as the screens' own
 * cancel buttons behave; the item ends `cancelled` once it does.
 */
async function cancelCurrentItem(): Promise<void> {
  const runtime = schedulerRuntime();
  const current = runtime.current;
  if (!current) throw new ValidationError("No scheduled item is running.");
  runtime.cancelRequested = true;
  // Before dispatch the flag alone is enough: the item is never enqueued.
  if (current.phase !== "running") return;
  await cancelDispatchedRun(current.projectId, current.runType);
}

/**
 * Cancel the queue run behind an item — only while it is active. The legacy
 * queues remember a cancel per project until their worker drains, so cancelling
 * an idle queue would silently empty the project's next run.
 */
async function cancelDispatchedRun(projectId: string, runType: RunType): Promise<void> {
  if (config.flags.durableTasks) {
    if (runType === "storyboard") await cancelDurableCanvasRun(projectId);
    else await cancelDurableSceneBatch(projectId);
  } else if (runType === "storyboard") {
    if (getCanvasQueue(projectId).active) cancelCanvasRun(projectId);
  } else if (getQueue(projectId).active) {
    cancelQueue(projectId);
  }
}

// ---------------------------------------------------------------------------
// Worker (FR-11)
// ---------------------------------------------------------------------------

type Outcome = {
  state: ItemState;
  reason?: string;
  summary?: ItemSummary;
};

function setPhase(phase: PreparingPhase): void {
  const current = schedulerRuntime().current;
  if (!current) return;
  current.phase = phase;
  current.phaseStartedAt = now();
}

/**
 * One loop per process; `loopActive` is the lock. It exists only while the
 * schedule is `running` and ends the moment it is paused or completes.
 */
async function runLoop(): Promise<void> {
  const runtime = schedulerRuntime();
  if (runtime.loopActive) return;
  runtime.loopActive = true;

  try {
    for (;;) {
      let schedule = await store().read();
      if (schedule.state !== "running") return;

      // 1. Wait for idle — including runs started by hand before Start.
      const waitBegan = Date.now();
      while (isGenerationBusy()) {
        runtime.waitingFor = await describeBusy();
        await sleep(timing.followMs);
        schedule = await store().read();
        if (schedule.state !== "running") return;
      }
      runtime.waitingFor = null;

      // 2. Pick.
      const next = schedule.items.find((item) => item.state === "queued");
      if (!next) {
        await store().mutate((draft) => {
          if (draft.state === "running") draft.state = "completed";
        });
        logEvent("scheduler.completed", {});
        return;
      }

      await runItem(next.id, Math.round((Date.now() - waitBegan) / 1000));

      // 8. Settle, so WanGP can release the last model before the next load.
      const after = await store().read();
      if (
        timing.settleMs > 0 &&
        after.state === "running" &&
        after.items.some((item) => item.state === "queued")
      ) {
        await sleep(timing.settleMs);
      }
    }
  } catch (err) {
    await recoverFromLoopError(err);
  } finally {
    runtime.loopActive = false;
    runtime.waitingFor = null;
  }
}

/**
 * The loop died on something unexpected — most likely the schedule file could
 * not be written. Leave a state the operator can act on: the item that was
 * running is marked interrupted and the schedule pauses, as after a restart.
 */
async function recoverFromLoopError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logEvent("scheduler.restart_interrupted", { reason: "worker_error", error: cap(message) });
  try {
    await store().mutate((draft) => {
      const at = now();
      for (const item of draft.items) {
        if (item.state !== "running") continue;
        item.state = "interrupted";
        item.reason = cap(`The Scheduler hit an error: ${message}`);
        item.finishedAt = at;
      }
      if (draft.state === "running") draft.state = "paused";
    });
  } catch {
    // The store itself is failing; the in-memory pointer is already cleared,
    // so manual runs are no longer refused.
  }
}

type DispatchPlan = { record: ProjectRecord; sceneIds?: string[]; dropped: number[] };

/** 3. Revalidate. Returns a reason to skip, or what to dispatch. */
async function checkAtDispatch(item: ScheduleItem): Promise<{ skip: string } | DispatchPlan> {
  const record = await findRecord(item.projectId);
  if (!record) return { skip: "Project was deleted." };
  const problem = intrinsicProblem(item, record);
  if (problem) return { skip: problem };
  if (item.runType === "storyboard") return { record, dropped: [] };

  if (!record.storyboard) return { skip: "The project has no storyboard to render." };

  let sceneIds: string[] | undefined;
  const dropped: number[] = [];
  if (item.scope.mode === "selected") {
    const scope = item.scope;
    const existing = new Set(record.storyboard.scenes.map((scene) => scene.id));
    sceneIds = scope.sceneIds.filter((id) => existing.has(id));
    scope.sceneIds.forEach((id, index) => {
      if (!existing.has(id)) dropped.push(scope.sceneNumbers[index] ?? 0);
    });
    if (!sceneIds.length) return { skip: "None of the picked scenes exist any more." };
  }

  // FR-15: every scene failing one after another would cost the same outcome
  // plus a retry delay per scene.
  const wangp = await getWangpStatus().catch(() => null);
  if (!wangp?.ok) return { skip: "WanGP is not reachable. Start it, then requeue this item." };
  if (wangp.filesystemReads === false) {
    return {
      skip: "WanGP has filesystem reads turned off, so every render would be refused. Restart it with filesystem reads on.",
    };
  }
  return { record, sceneIds, dropped };
}

async function updateItem(itemId: string, fn: (item: ScheduleItem) => void): Promise<void> {
  await store().mutate((draft) => {
    const item = draft.items.find((candidate) => candidate.id === itemId);
    if (item) fn(item);
  });
}

async function runItem(itemId: string, waitedSeconds: number): Promise<void> {
  const runtime = schedulerRuntime();
  runtime.cancelRequested = false;

  // Claim the item and the GPU in one step, under the store's lock. Until this
  // write lands the item can still be removed or edited and a manual run can
  // still start, so everything those could change is re-checked here.
  const startedAt = now();
  const correlationId = randomUUID();
  const { result: claimed } = await store().mutate((draft) => {
    if (draft.state !== "running") return null;
    const target = draft.items.find((candidate) => candidate.id === itemId);
    if (!target || target.state !== "queued") return null;
    if (isGenerationBusy()) return null;

    // "Item 2 of 5" counts this batch, not last night's history.
    const batch = draft.items.filter(
      (candidate) =>
        candidate.state === "queued" ||
        candidate.state === "running" ||
        (isFinishedItem(candidate.state) &&
          Boolean(draft.startedAt && candidate.finishedAt && candidate.finishedAt >= draft.startedAt)),
    );
    runtime.current = {
      itemId,
      projectId: target.projectId,
      runType: target.runType,
      label: itemLabel(target),
      position: batch.findIndex((candidate) => candidate.id === itemId) + 1,
      total: batch.length,
      phase: "waiting",
      phaseStartedAt: startedAt,
      startedAt,
    };
    target.state = "running";
    target.reason = undefined;
    target.startedAt = startedAt;
    target.finishedAt = undefined;
    target.waitedSeconds = waitedSeconds;
    target.correlationId = correlationId;
    target.preparation = { wangpRestart: null, planningModelLoaded: null, warnings: [] };
    return structuredClone(target);
  });
  if (!claimed) return;
  const item = claimed;

  try {
    const plan = await checkAtDispatch(item);
    if ("skip" in plan) {
      await finishItem(item, { state: "skipped", reason: plan.skip }, waitedSeconds);
      return;
    }

    const current = runtime.current;
    if (current) current.label = itemLabel({ runType: item.runType, projectTitle: plan.record.project.title });
    await updateItem(itemId, (draft) => {
      draft.projectTitle = plan.record.project.title.slice(0, 300);
    });
    logEvent("scheduler.item_dispatched", {
      itemId,
      projectId: item.projectId,
      runType: item.runType,
      correlationId,
      waitedSeconds,
    });

    let outcome: Outcome;
    try {
      const failure = item.runType === "storyboard" ? await prepareStoryboard(itemId) : null;
      if (failure) outcome = { state: "failed", reason: failure };
      else if (runtime.cancelRequested) outcome = { state: "cancelled", reason: "Cancelled before it started." };
      else outcome = await dispatchAndFollow(item, plan, correlationId);
    } catch (err) {
      outcome = { state: "failed", reason: err instanceof Error ? err.message : "Dispatch failed" };
    } finally {
      runtime.suppressAutoStart.delete(item.projectId);
    }

    if (plan.dropped.length) {
      outcome.summary = {
        ...(outcome.summary ?? { completed: 0, failed: 0, skipped: 0, total: 0 }),
        droppedScenes: plan.dropped,
      };
    }
    await finishItem(item, outcome, waitedSeconds);
  } finally {
    // Whatever happened above, a stale pointer would refuse every manual run
    // with a message about an item that is no longer running.
    runtime.current = null;
    runtime.cancelRequested = false;
  }
}

/**
 * FR-15 for a storyboard item: free WanGP's memory after a render, then load
 * the planning model. Returns a reason when the item must fail.
 */
async function prepareStoryboard(itemId: string): Promise<string | null> {
  const runtime = schedulerRuntime();
  const preparation: ItemPreparation = { wangpRestart: null, planningModelLoaded: null, warnings: [] };

  if (runtime.lastRunType === "keyframes" || runtime.lastRunType === "video") {
    setPhase("restarting_wangp");
    const result = await restartWangp();
    preparation.wangpRestart = result;
    if ((result.outcome === "not_managed" || result.outcome === "unhealthy") && result.detail) {
      preparation.warnings.push(result.detail);
    }
    await updateItem(itemId, (item) => {
      item.preparation = structuredClone(preparation);
    });
  }

  if (config.llmRuntime.enabled) {
    setPhase("loading_planning_model");
    try {
      const status = await getLlmRuntimeStatus();
      if (!status.configuredModelLoaded) {
        await loadPlanningModel();
        preparation.planningModelLoaded = true;
      } else {
        preparation.planningModelLoaded = false;
      }
    } catch (err) {
      return `Could not load the planning model: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await updateItem(itemId, (item) => {
        item.preparation = structuredClone(preparation);
      });
    }
  }
  return null;
}

/** 6. Follow: poll until the underlying run is no longer active. */
async function follow(active: () => boolean | Promise<boolean>): Promise<void> {
  while (await active()) await sleep(timing.followMs);
}

/**
 * The run is now in its queue. From here Cancel goes to the queue; a cancel
 * that arrived while it was being enqueued is passed on now.
 */
async function markDispatched(item: ScheduleItem): Promise<void> {
  setPhase("running");
  if (schedulerRuntime().cancelRequested) await cancelDispatchedRun(item.projectId, item.runType);
}

async function durableTask(projectId: string, taskId: string): Promise<Task | undefined> {
  return (await listTasks(projectId)).find((task) => task.id === taskId);
}

async function dispatchAndFollow(item: ScheduleItem, plan: DispatchPlan, correlationId: string): Promise<Outcome> {
  const runtime = schedulerRuntime();
  const projectId = item.projectId;

  if (config.flags.durableTasks) {
    let task: Task;
    if (item.runType === "storyboard") {
      runtime.suppressAutoStart.add(projectId);
      runtime.autoStartSuppressed.delete(projectId);
      task = await enqueueDurableCanvasRun(projectId, { includeStoryboard: true, correlationId });
    } else {
      const all = plan.record.storyboard!.scenes.map((scene) => scene.id);
      const ids = plan.sceneIds ? videoRerunScope(plan.record, plan.sceneIds).sceneIds : all;
      task = await enqueueDurableSceneBatch(projectId, ids, { correlationId });
    }
    runtime.lastRunType = item.runType;
    if (runtime.current) runtime.current.durableTaskId = task.id;
    await updateItem(item.id, (draft) => {
      draft.durableTaskId = task.id;
    });
    await markDispatched(item);
    await follow(async () => {
      const latest = await durableTask(projectId, task.id);
      return Boolean(latest && isActive(latest.state));
    });
    return summariseDurable(item, (await durableTask(projectId, task.id)) ?? task);
  }

  if (item.runType === "storyboard") {
    runtime.suppressAutoStart.add(projectId);
    runtime.autoStartSuppressed.delete(projectId);
    enqueueCanvasRun(projectId, { includeStoryboard: true });
    runtime.lastRunType = "storyboard";
    await markDispatched(item);
    await follow(() => getCanvasQueue(projectId).active);
    return summariseCanvas(projectId);
  }

  clearFinished(projectId);

  if (item.runType === "keyframes") {
    const rerender = item.scope.mode === "all" && item.options.keyframes === "rerender";
    const sceneIds = plan.sceneIds ?? (rerender ? undefined : missingKeyframeSceneIds(plan.record));
    if (sceneIds && sceneIds.length === 0) {
      return {
        state: "completed",
        summary: { completed: 0, failed: 0, skipped: 0, total: 0, notes: ["Nothing to render — every scene already has keyframes."] },
      };
    }
    const { followOn } = await enqueueKeyframeRerun(projectId, sceneIds);
    runtime.lastRunType = "keyframes";
    await markDispatched(item);
    await follow(() => getQueue(projectId).active);
    const outcome = summariseScenes(projectId);
    if (followOn.length) outcome.summary = { ...outcome.summary!, followOn };
    return outcome;
  }

  const { entries, cascaded, skippedFinished } = await enqueueSceneRun(projectId, {
    sceneIds: plan.sceneIds,
    redoFinished: item.options.redoFinished,
  });
  if (!entries.length) {
    return {
      state: "completed",
      summary: {
        completed: 0,
        failed: 0,
        skipped: skippedFinished,
        total: skippedFinished,
        cascaded,
        notes: ["Nothing to render — every scene in scope already has its clip."],
      },
    };
  }
  runtime.lastRunType = "video";
  await markDispatched(item);
  await follow(() => getQueue(projectId).active);
  const outcome = summariseScenes(projectId);
  outcome.summary = {
    ...outcome.summary!,
    skipped: outcome.summary!.skipped + skippedFinished,
    total: outcome.summary!.total + skippedFinished,
    cascaded,
  };
  return outcome;
}

function autoStartNote(projectId: string): string[] | undefined {
  const runtime = schedulerRuntime();
  if (!runtime.autoStartSuppressed.delete(projectId)) return undefined;
  return ["Full auto media start was skipped — add a Video item to render it."];
}

function summariseCanvas(projectId: string): Outcome {
  const { entries } = getCanvasQueue(projectId);
  const failed = entries.filter((entry) => entry.state === "failed");
  const cancelled = entries.filter((entry) => entry.state === "cancelled").length;
  const summary: ItemSummary = {
    completed: entries.filter((entry) => entry.state === "completed").length,
    failed: failed.length,
    skipped: cancelled,
    total: entries.length,
    firstError: cap(failed[0] ? `${failed[0].agentName}: ${failed[0].error ?? "failed"}` : undefined),
    notes: autoStartNote(projectId),
  };
  if (failed.length) return { state: "failed", reason: summary.firstError, summary };
  if (schedulerRuntime().cancelRequested || cancelled) return { state: "cancelled", summary };
  return { state: "completed", summary };
}

function summariseScenes(projectId: string): Outcome {
  const { entries } = getQueue(projectId);
  const failed = entries.filter((entry) => entry.state === "failed");
  const completed = entries.filter((entry) => entry.state === "completed").length;
  const cancelled = entries.filter((entry) => entry.state === "cancelled").length;
  const summary: ItemSummary = {
    completed,
    failed: failed.length,
    skipped: cancelled,
    total: entries.length,
    firstError: cap(failed[0] ? `Scene ${failed[0].sceneNumber}: ${failed[0].error ?? "failed"}` : undefined),
  };
  if (schedulerRuntime().cancelRequested) return { state: "cancelled", summary };
  // Cancelled from the Storyboard screen's own button: still not a finished run.
  if (cancelled && !failed.length) return { state: "cancelled", summary };
  if (!failed.length) return { state: "completed", summary };
  if (!completed) return { state: "failed", reason: summary.firstError, summary };
  return { state: "completed_with_errors", summary };
}

function summariseDurable(item: ScheduleItem, task: Task): Outcome {
  const entries = task.entries;
  const completed = entries.filter((entry) => entry.state === "completed").length;
  const cancelled = entries.filter((entry) => entry.state === "cancelled").length;
  const failed = entries.filter((entry) => entry.state !== "completed" && entry.state !== "cancelled");
  const first = failed[0];
  const summary: ItemSummary = {
    completed,
    failed: failed.length,
    skipped: cancelled,
    total: entries.length,
    firstError: cap(first ? `${first.label}: ${first.error ?? first.state}` : undefined),
    notes: item.runType === "storyboard" ? autoStartNote(item.projectId) : undefined,
  };
  if (schedulerRuntime().cancelRequested) return { state: "cancelled", summary };
  if (!failed.length) return { state: cancelled ? "cancelled" : "completed", summary };
  if (item.runType === "storyboard" || !completed) return { state: "failed", reason: summary.firstError, summary };
  return { state: "completed_with_errors", summary };
}

/** 7. Record, and apply the failure policy (FR-13). */
async function finishItem(item: ScheduleItem, outcome: Outcome, waitedSeconds: number): Promise<void> {
  const finishedAt = now();
  const skippedLater: string[] = [];
  await store().mutate((draft) => {
    const index = draft.items.findIndex((candidate) => candidate.id === item.id);
    const target = draft.items[index];
    if (!target) return;
    target.state = outcome.state;
    target.reason = cap(outcome.reason);
    target.finishedAt = finishedAt;
    target.startedAt ??= finishedAt;
    target.waitedSeconds ??= waitedSeconds;
    if (outcome.summary) target.summary = outcome.summary;

    if (outcome.state === "failed") {
      const reason = `Skipped because the ${RUN_TYPE_LABELS[item.runType]} run for this project failed.`;
      for (const later of draft.items.slice(index + 1)) {
        if (later.projectId !== item.projectId || later.state !== "queued") continue;
        later.state = "skipped";
        later.reason = reason;
        later.finishedAt = finishedAt;
        skippedLater.push(later.id);
      }
    }
    pruneHistory(draft);
  });

  if (outcome.state === "skipped") {
    logEvent("scheduler.item_skipped", { itemId: item.id, projectId: item.projectId, reason: cap(outcome.reason) });
  } else {
    const startedAt = schedulerRuntime().current?.startedAt ?? finishedAt;
    logEvent("scheduler.item_finished", {
      itemId: item.id,
      projectId: item.projectId,
      runType: item.runType,
      outcome: outcome.state,
      seconds: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
      completed: outcome.summary?.completed,
      failed: outcome.summary?.failed,
      skipped: outcome.summary?.skipped,
    });
  }
  for (const id of skippedLater) {
    logEvent("scheduler.item_skipped", { itemId: id, projectId: item.projectId, reason: "earlier_failure" });
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type CurrentProgress =
  | { kind: "agents"; agentName?: string; progress?: AgentProgress; done: number; total: number }
  | { kind: "scenes"; done: number; failed: number; total: number; phase?: PhaseProgress };

export type SchedulerSnapshot = {
  schedule: RunSchedule;
  current: (SchedulerCurrent & { progress: CurrentProgress | null }) | null;
  /** What the worker is waiting behind (FR-11 step 1). */
  waitingFor: string | null;
  /** What holds the GPU right now, whoever started it (FR-17). */
  busy: string | null;
  wangpRestartAvailable: boolean;
  durableTasks: boolean;
};

async function currentProgress(current: SchedulerCurrent): Promise<CurrentProgress | null> {
  if (current.phase !== "running") return null;
  if (current.durableTaskId) {
    const task = await durableTask(current.projectId, current.durableTaskId).catch(() => undefined);
    if (!task) return null;
    const running = task.entries.find((entry) => isActive(entry.state) && entry.state !== "pending");
    const done = task.entries.filter((entry) => entry.state === "completed").length;
    return current.runType === "storyboard"
      ? { kind: "agents", agentName: running?.label, done, total: task.entries.length }
      : {
          kind: "scenes",
          done,
          failed: task.entries.filter((entry) => entry.state === "failed").length,
          total: task.entries.length,
        };
  }
  if (current.runType === "storyboard") {
    const queue = getCanvasQueue(current.projectId);
    const running = queue.entries.find((entry) => entry.state === "running");
    return {
      kind: "agents",
      agentName: running?.agentName,
      progress: running?.progress,
      done: queue.done,
      total: queue.total,
    };
  }
  const queue = getQueue(current.projectId);
  return {
    kind: "scenes",
    done: queue.entries.filter((entry) => entry.state === "completed").length,
    failed: queue.entries.filter((entry) => entry.state === "failed").length,
    total: queue.entries.length,
    phase: queue.phase,
  };
}

/**
 * Bring waiting items up to date with the projects they name: a deleted
 * project skips its items, and a storyboard made by hand can make an item
 * valid. Writes only when something changed, so polling never churns the
 * revision a client is holding.
 */
async function refreshWaitingItems(schedule: RunSchedule): Promise<RunSchedule> {
  const waiting = schedule.items.filter((item) => item.state === "queued" || item.state === "invalid");
  if (!waiting.length) return schedule;
  const records = new Map<string, ProjectRecord | null>();
  for (const id of new Set(waiting.map((item) => item.projectId))) records.set(id, await findRecord(id));

  const preview = structuredClone(schedule);
  const deleted = preview.items.some(
    (item) => (item.state === "queued" || item.state === "invalid") && !records.get(item.projectId),
  );
  const storyboards = new Map([...records].map(([id, record]) => [id, Boolean(record?.storyboard)]));
  if (!deleted && !applyOrdering(preview, storyboards)) return schedule;

  const { schedule: next } = await store().mutate((draft) => {
    const finishedAt = now();
    for (const item of draft.items) {
      if ((item.state === "queued" || item.state === "invalid") && records.has(item.projectId) && !records.get(item.projectId)) {
        item.state = "skipped";
        item.reason = "Project was deleted.";
        item.finishedAt = finishedAt;
      }
    }
    applyOrdering(draft, storyboards);
  });
  return next;
}

export async function getScheduleState(): Promise<RunSchedule["state"]> {
  return (await store().read()).state;
}

export async function getSchedulerSnapshot(): Promise<SchedulerSnapshot> {
  const runtime = schedulerRuntime();
  const schedule = await refreshWaitingItems(await store().read());
  const current = runtime.current;
  return {
    schedule,
    current: current ? { ...current, progress: await currentProgress(current) } : null,
    waitingFor: runtime.waitingFor,
    busy: await describeBusy(),
    wangpRestartAvailable: await wangpRestartAvailable(),
    durableTasks: config.flags.durableTasks,
  };
}

// ---------------------------------------------------------------------------
// Add-form lookups
// ---------------------------------------------------------------------------

export type SchedulableProject = {
  id: string;
  title: string;
  generationMode: ProjectRecord["project"]["generationMode"];
  hasStoryboard: boolean;
  sceneCount: number;
};

export type SchedulableScene = {
  id: string;
  sceneNumber: number;
  title: string;
  hasKeyframes: boolean;
  hasClip: boolean;
};

export async function listSchedulableProjects(): Promise<SchedulableProject[]> {
  const records = await repository.list();
  return records
    .map((record) => ({
      id: record.project.id,
      title: record.project.title,
      generationMode: record.project.generationMode,
      hasStoryboard: Boolean(record.storyboard),
      sceneCount: record.storyboard?.scenes.length ?? 0,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Scenes with what their chosen attempt already holds, for the scene picker. */
export async function schedulableScenes(projectId: string): Promise<SchedulableScene[]> {
  const record = await getProjectRecord(projectId);
  return (record.storyboard?.scenes ?? []).map((scene) => {
    const attempt = chosenAttempt(record, scene.id);
    return {
      id: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      hasKeyframes: Boolean(attempt?.startImagePath),
      hasClip: Boolean(attempt?.videoPath),
    };
  });
}

// ---------------------------------------------------------------------------
// Startup (FR-22)
// ---------------------------------------------------------------------------

/**
 * Apply restart behaviour: a running schedule comes back paused, the item that
 * was running becomes `interrupted`, and nothing starts until Resume. The
 * legacy queues are in memory, so the run behind that item is already gone.
 */
export async function loadScheduleAtStartup(): Promise<void> {
  const schedule = await store().read();
  const running = schedule.items.filter((item) => item.state === "running");
  if (schedule.state !== "running" && !running.length) return;

  await store().mutate((draft) => {
    const at = now();
    if (draft.state === "running") draft.state = "paused";
    for (const item of draft.items) {
      if (item.state !== "running") continue;
      item.state = "interrupted";
      item.reason = "StoryForge restarted while this was running.";
      item.finishedAt = at;
      draft.restartNotice = { itemId: item.id, label: itemLabel(item), at };
    }
  });
  logEvent("scheduler.restart_interrupted", { interrupted: running.length });
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Resolve once the worker loop has stopped. */
export async function waitForSchedulerIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!schedulerRuntime().loopActive) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Scheduler did not go idle in time");
}

export { runLoop as runSchedulerLoopForTest };
