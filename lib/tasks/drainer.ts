import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { isActive, type Task, type TaskEntry } from "@/lib/schemas/tasks";
import {
  acquireLease,
  annotateEntry,
  moveEntry,
  releaseLease,
  listTasks,
} from "@/lib/tasks/task-service";

/**
 * The shared durable drainer (SPEC-008 slices 3 and 4).
 *
 * One loop serves the canvas run and the scene batch: both are "walk an ordered
 * list of entries, run each, record what happened". What differs is the work
 * itself, which arrives as `runEntry`.
 *
 * Everything here is written through `task-service`, so a crash at any point
 * leaves a file that reconciliation can read.
 */

export type RunOutcome =
  | { kind: "completed" }
  | { kind: "failed"; detail: string; retryable: boolean }
  | { kind: "cancelled" };

export type DrainHandlers = {
  /**
   * Perform one entry's work.
   *
   * `onSubmitted` must be called with the backend's job id the instant it is
   * known — that is what turns an ambiguous restart into a resumable one.
   */
  runEntry: (
    entry: TaskEntry,
    hooks: { onSubmitted: (externalJobId: string) => Promise<void> },
  ) => Promise<RunOutcome>;
  /** Poll a reconciling entry instead of resubmitting it (FR-4). */
  reconcileEntry?: (entry: TaskEntry) => Promise<RunOutcome | "unknown">;
  /** Called before each entry; returning true stops the run. */
  shouldStop?: () => boolean;
  /** One failure aborts the rest, as the canvas run does today. */
  abortOnFailure?: boolean;
};

const globalRef = globalThis as unknown as { __storyforgeDurableDrains?: Set<string> };

/** In-process guard, so one project cannot be drained twice concurrently. */
function inFlight(): Set<string> {
  return (globalRef.__storyforgeDurableDrains ??= new Set());
}

export function isDraining(projectId: string): boolean {
  return inFlight().has(projectId);
}

/**
 * Drain one project's active task.
 *
 * Two locks, deliberately: the in-process set stops re-entrancy inside one
 * Node process, and the persisted lease stops a second process (or a module
 * graph left over from HMR) starting a parallel drainer.
 */
export async function drainTask(
  projectId: string,
  taskId: string,
  handlers: DrainHandlers,
): Promise<void> {
  if (inFlight().has(projectId)) {
    logEvent("task.drain_skipped", { projectId, reason: "in_process" });
    return;
  }
  // Claimed synchronously, before any await: two callers starting in the same
  // tick would both clear a check that had an await after it, and the lease
  // cannot separate them because they share this process's worker id.
  inFlight().add(projectId);

  try {
    if (!(await acquireLease(projectId))) {
      logEvent("task.drain_skipped", { projectId, reason: "lease_held" });
      return;
    }

    for (;;) {
      const task = (await listTasks(projectId)).find((t) => t.id === taskId);
      if (!task) break;

      const next = nextEntry(task);
      if (!next) break;
      if (handlers.shouldStop?.()) break;

      // Renew while we work; a long batch must not let the lease lapse.
      await acquireLease(projectId);

      if (next.state === "reconciling") {
        await reconcile(projectId, taskId, next, handlers);
        continue;
      }

      const aborted = await runOne(projectId, taskId, next, handlers);
      if (aborted) break;
    }
  } finally {
    inFlight().delete(projectId);
    await releaseLease(projectId).catch(() => undefined);
  }
}

/** Lowest-ordered entry that still needs doing. */
function nextEntry(task: Task): TaskEntry | undefined {
  return [...task.entries]
    .filter((e) => e.state === "pending" || e.state === "reconciling")
    .sort((a, b) => a.order - b.order)[0];
}

async function reconcile(
  projectId: string,
  taskId: string,
  entry: TaskEntry,
  handlers: DrainHandlers,
): Promise<void> {
  const outcome = await handlers.reconcileEntry?.(entry);

  if (!outcome || outcome === "unknown") {
    // The backend cannot tell us what happened, so a human must decide.
    await moveEntry(projectId, taskId, entry.id, "interrupted", {
      detail: "Could not confirm the backend job after restart",
      expect: "reconciling",
    });
    return;
  }
  if (outcome.kind === "completed") {
    await moveEntry(projectId, taskId, entry.id, "completed", { expect: "reconciling" });
    return;
  }
  if (outcome.kind === "cancelled") {
    await moveEntry(projectId, taskId, entry.id, "cancelled", { expect: "reconciling" });
    return;
  }
  await moveEntry(projectId, taskId, entry.id, "failed", {
    detail: outcome.detail,
    expect: "reconciling",
  });
}

/** Returns true when the run should abort. */
async function runOne(
  projectId: string,
  taskId: string,
  entry: TaskEntry,
  handlers: DrainHandlers,
): Promise<boolean> {
  await annotateEntry(projectId, taskId, entry.id, { attempts: entry.attempts + 1 });

  // Intent is persisted *before* the backend is touched (FR-2). A crash from
  // here on is detectable, which is the whole reason this state exists.
  await moveEntry(projectId, taskId, entry.id, "submitting", { expect: "pending" });

  let outcome: RunOutcome;
  try {
    outcome = await handlers.runEntry(entry, {
      onSubmitted: async (externalJobId) => {
        await moveEntry(projectId, taskId, entry.id, "submitted", {
          externalJobId,
          expect: "submitting",
        });
        await moveEntry(projectId, taskId, entry.id, "running", { expect: "submitted" });
      },
    });
  } catch (err) {
    outcome = {
      kind: "failed",
      detail: err instanceof Error ? err.message : "Failed",
      retryable: false,
    };
  }

  const current = (await listTasks(projectId))
    .find((t) => t.id === taskId)
    ?.entries.find((e) => e.id === entry.id);
  const from = current?.state ?? "submitting";

  if (outcome.kind === "completed") {
    // A run that never reported a job id is still in `submitting`; walk it
    // forward rather than inventing an illegal jump.
    if (from === "submitting") {
      await moveEntry(projectId, taskId, entry.id, "submitted");
      await moveEntry(projectId, taskId, entry.id, "running");
    }
    await moveEntry(projectId, taskId, entry.id, "completed");
    return false;
  }

  if (outcome.kind === "cancelled") {
    await moveEntry(projectId, taskId, entry.id, "cancel_requested");
    await moveEntry(projectId, taskId, entry.id, "cancelled");
    return true;
  }

  await moveEntry(projectId, taskId, entry.id, "failed", { detail: outcome.detail });
  return Boolean(handlers.abortOnFailure);
}

/** Whether the durable path owns this project's work. */
export function durableTasksEnabled(): boolean {
  return config.flags.durableTasks;
}

export function hasOutstandingWork(task: Task | undefined): boolean {
  return Boolean(task?.entries.some((e) => isActive(e.state)));
}
