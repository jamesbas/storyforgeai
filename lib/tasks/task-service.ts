import { randomUUID } from "node:crypto";
import { logEvent } from "@/lib/telemetry";
import { taskRepository, workerId } from "@/lib/db/task-repository";
import {
  MAX_ENTRIES_PER_TASK,
  isActive,
  isTerminal,
  needsOperator,
  type Task,
  type TaskEntry,
  type TaskFile,
  type TaskKind,
  type TaskPhase,
  type TaskState,
} from "@/lib/schemas/tasks";
import { deriveTaskState, reconcileState, transition } from "@/lib/tasks/state-machine";

/**
 * Task lifecycle operations (SPEC-008).
 *
 * Every mutation goes through `taskRepository.mutate`, which serialises per
 * project and writes atomically, so a caller never has to think about the file.
 */

/** How long a drainer holds the lease before it must renew (ADR-008 §C). */
export const LEASE_MS = 60_000;

export type NewEntry = {
  ref: string;
  label: string;
  order: number;
  executionId?: string;
  composerVersion?: string;
};

function blankEntry(input: NewEntry): TaskEntry {
  return {
    id: randomUUID(),
    ref: input.ref,
    label: input.label,
    order: input.order,
    state: "pending",
    attempts: 0,
    history: [],
    executionId: input.executionId,
    composerVersion: input.composerVersion,
  };
}

export async function createTask(
  projectId: string,
  kind: TaskKind,
  entries: readonly NewEntry[],
  options: { correlationId?: string; phase?: TaskPhase } = {},
): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId,
    kind,
    state: "pending",
    phase: options.phase,
    correlationId: options.correlationId,
    createdAt: now,
    updatedAt: now,
    entries: entries.slice(0, MAX_ENTRIES_PER_TASK).map(blankEntry),
  };

  await taskRepository.mutate(projectId, (file) => {
    file.tasks.push(task);
  });
  logEvent("task.created", { projectId, taskId: task.id, kind, entries: task.entries.length });
  return task;
}

export async function listTasks(projectId: string): Promise<Task[]> {
  return (await taskRepository.read(projectId)).tasks;
}

export async function getTaskFile(projectId: string): Promise<TaskFile> {
  return taskRepository.read(projectId);
}

/** The task still doing something, or awaiting a decision. */
export async function activeTask(projectId: string): Promise<Task | undefined> {
  const tasks = await listTasks(projectId);
  return tasks.find((t) => !isTerminal(t.state));
}

function touch(task: Task): void {
  task.state = deriveTaskState(task.entries);
  task.updatedAt = new Date().toISOString();
}

/**
 * Move one entry, recomputing the task's own state from its entries.
 *
 * `expect` guards against a stale caller: a drainer that lost the lease and
 * came back must not overwrite a decision the recovery UI already made.
 */
export async function moveEntry(
  projectId: string,
  taskId: string,
  entryId: string,
  to: TaskState,
  options: { detail?: string; externalJobId?: string; expect?: TaskState } = {},
): Promise<void> {
  await taskRepository.mutate(projectId, (file) => {
    const task = file.tasks.find((t) => t.id === taskId);
    const entry = task?.entries.find((e) => e.id === entryId);
    if (!task || !entry) return;
    if (options.expect && entry.state !== options.expect) return;

    const next = transition(entry, to, {
      detail: options.detail,
      externalJobId: options.externalJobId,
    });
    task.entries = task.entries.map((e) => (e.id === entryId ? next : e));
    touch(task);
  });
  logEvent("task.transition", { projectId, taskId, entryId, to });
}

/** Record an attempt and the phase an entry is in, without a state change. */
export async function annotateEntry(
  projectId: string,
  taskId: string,
  entryId: string,
  patch: { attempts?: number; phase?: TaskPhase; externalJobId?: string; executionId?: string },
): Promise<void> {
  await taskRepository.mutate(projectId, (file) => {
    const task = file.tasks.find((t) => t.id === taskId);
    const entry = task?.entries.find((e) => e.id === entryId);
    if (!task || !entry) return;
    Object.assign(entry, patch);
    task.updatedAt = new Date().toISOString();
  });
}

/**
 * Ask to stop.
 *
 * Pending entries cancel outright. Anything in flight becomes
 * `cancel_requested` rather than `cancelled`, because the GPU job behind it is
 * still running and the UI must not claim otherwise (§7).
 */
export async function requestCancel(projectId: string, taskId?: string): Promise<number> {
  let affected = 0;
  await taskRepository.mutate(projectId, (file) => {
    for (const task of file.tasks) {
      if (taskId && task.id !== taskId) continue;
      if (isTerminal(task.state)) continue;
      task.cancelRequestedAt = new Date().toISOString();
      task.entries = task.entries.map((entry) => {
        if (entry.state === "pending" || entry.state === "retry_pending") {
          affected += 1;
          return transition(entry, "cancelled", { detail: "Cancelled before it started" });
        }
        if (isActive(entry.state) && entry.state !== "cancel_requested") {
          affected += 1;
          return transition(entry, "cancel_requested", { detail: "Stop after the current step" });
        }
        return entry;
      });
      touch(task);
    }
  });
  logEvent("task.cancel_requested", { projectId, taskId, affected });
  return affected;
}

/** Operator action: start a fresh attempt, keeping the previous diagnostics. */
export async function retryEntries(
  projectId: string,
  taskId: string,
  entryIds?: readonly string[],
): Promise<number> {
  let retried = 0;
  await taskRepository.mutate(projectId, (file) => {
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.entries = task.entries.map((entry) => {
      const wanted = !entryIds || entryIds.includes(entry.id);
      const retryable =
        entry.state === "failed" || needsOperator(entry.state) || entry.state === "stop_tracking";
      if (!wanted || !retryable) return entry;
      retried += 1;
      // Two hops: the machine only allows pending via retry_pending, so a
      // retry is always visible as a deliberate act in the history.
      const staged = transition(entry, "retry_pending", { detail: "Retry requested" });
      return transition(staged, "pending");
    });
    task.cancelRequestedAt = undefined;
    touch(task);
  });
  logEvent("task.retry", { projectId, taskId, retried });
  return retried;
}

/** Operator action: give up waiting. The backend job may still be running. */
export async function stopTracking(projectId: string, taskId: string): Promise<number> {
  let stopped = 0;
  await taskRepository.mutate(projectId, (file) => {
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.entries = task.entries.map((entry) => {
      if (isTerminal(entry.state)) return entry;
      stopped += 1;
      // Work that was never submitted has no backend job to abandon, so
      // cancelling it states the truth; "stop tracking" would imply a job.
      const neverSubmitted = entry.state === "pending" || entry.state === "retry_pending";
      return neverSubmitted
        ? transition(entry, "cancelled", { detail: "Cancelled before it started" })
        : transition(entry, "stop_tracking", { detail: "Operator stopped tracking" });
    });
    touch(task);
  });
  logEvent("task.stop_tracking", { projectId, taskId, stopped });
  return stopped;
}

/** Remove finished tasks from view. Never touches anything unresolved. */
export async function dismissCompleted(projectId: string): Promise<number> {
  let removed = 0;
  await taskRepository.mutate(projectId, (file) => {
    const before = file.tasks.length;
    file.tasks = file.tasks.filter((t) => !isTerminal(t.state) || needsOperator(t.state));
    removed = before - file.tasks.length;
  });
  return removed;
}

/**
 * Reconcile everything left mid-flight by a previous process (FR-3).
 *
 * Runs once at startup. It decides only what an entry *becomes*; actually
 * polling the backend is the drainer's job, because that needs a client.
 */
export async function reconcileProject(projectId: string): Promise<{
  reconciling: number;
  interrupted: number;
  unknown: number;
}> {
  const counts = { reconciling: 0, interrupted: 0, unknown: 0 };

  await taskRepository.mutate(projectId, (file) => {
    for (const task of file.tasks) {
      if (isTerminal(task.state)) continue;
      task.entries = task.entries.map((entry) => {
        const next = reconcileState(entry);
        if (!next) return entry;
        if (next === "reconciling") counts.reconciling += 1;
        if (next === "interrupted") counts.interrupted += 1;
        if (next === "submission_unknown") counts.unknown += 1;
        return transition(entry, next, {
          detail:
            next === "submission_unknown"
              ? "Restarted while submitting; the backend may or may not have accepted it"
              : "Restarted while in flight",
        });
      });
      touch(task);
    }
    // A lease held by a process that is gone must not block the new one.
    file.lease = undefined;
  });

  if (counts.reconciling || counts.interrupted || counts.unknown) {
    logEvent("task.reconciled", { projectId, ...counts });
  }
  return counts;
}

/**
 * Take or renew the per-project drainer lease (FR-10).
 *
 * Cooperative and single-host. It stops a second drainer starting after an HMR
 * reload, which is the failure this app actually has; it is not a distributed
 * lock and two Node processes on one data dir would still race.
 */
export async function acquireLease(projectId: string): Promise<boolean> {
  const me = workerId();
  let held = false;
  await taskRepository.mutate(projectId, (file) => {
    const now = Date.now();
    const lease = file.lease;
    const free = !lease || Date.parse(lease.heldUntil) < now || lease.owner === me;
    if (!free) return;
    file.lease = { owner: me, heldUntil: new Date(now + LEASE_MS).toISOString() };
    held = true;
  });
  return held;
}

export async function releaseLease(projectId: string): Promise<void> {
  const me = workerId();
  await taskRepository.mutate(projectId, (file) => {
    if (file.lease?.owner === me) file.lease = undefined;
  });
}
