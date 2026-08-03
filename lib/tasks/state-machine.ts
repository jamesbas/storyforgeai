import { redactDetail } from "@/lib/schemas/provenance";
import {
  MAX_HISTORY_PER_ENTRY,
  isActive,
  isTerminal,
  needsOperator,
  type TaskEntry,
  type TaskState,
} from "@/lib/schemas/tasks";

/**
 * The SPEC-008 state machine, kept apart from storage so the rules can be
 * tested without a filesystem.
 *
 * The rule that shapes everything else: WanGP generation is not idempotent, so
 * no transition may ever move an entry that *might* have a live backend job
 * back to `pending`. Ambiguity resolves towards asking a human.
 */

const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  pending: ["submitting", "running", "cancelled", "cancel_requested", "failed"],
  // `submission_unknown` is the restart case; `failed` is a submission that
  // was refused outright, which is safe because nothing was accepted.
  // `stop_tracking` is the operator's escape hatch: available wherever a
  // backend job might exist, because giving up watching must always be possible.
  submitting: ["submitted", "failed", "submission_unknown", "cancel_requested", "stop_tracking"],
  submitted: [
    "running",
    "completed",
    "failed",
    "cancel_requested",
    "interrupted",
    "reconciling",
    "stop_tracking",
  ],
  running: [
    "completed",
    "failed",
    "cancel_requested",
    "interrupted",
    "reconciling",
    "stop_tracking",
  ],
  reconciling: ["running", "completed", "failed", "interrupted", "stop_tracking", "cancelled"],
  completed: [],
  failed: ["retry_pending"],
  // A retry is a fresh attempt, so this is the one route back to pending.
  retry_pending: ["pending", "cancelled"],
  cancelled: [],
  cancel_requested: ["cancelled", "completed", "failed", "stop_tracking", "interrupted"],
  // An operator may resume polling, give up, or retry from scratch.
  interrupted: ["reconciling", "retry_pending", "stop_tracking", "cancelled"],
  submission_unknown: ["reconciling", "retry_pending", "stop_tracking", "cancelled"],
  stop_tracking: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED[from].includes(to);
}

export class TaskTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Cannot move a task entry from ${from} to ${to}.`);
    this.name = "TaskTransitionError";
  }
}

/**
 * Apply a transition, returning a new entry.
 *
 * Pure: the caller decides whether to persist. History is bounded here rather
 * than at write time so a retry loop cannot grow an entry without limit.
 */
export function transition(
  entry: TaskEntry,
  to: TaskState,
  options: { detail?: string; at?: Date; externalJobId?: string } = {},
): TaskEntry {
  if (!canTransition(entry.state, to)) throw new TaskTransitionError(entry.state, to);

  const at = (options.at ?? new Date()).toISOString();
  const detail = redactDetail(options.detail);
  const history = [...entry.history, { at, from: entry.state, to, detail }].slice(
    -MAX_HISTORY_PER_ENTRY,
  );

  return {
    ...entry,
    state: to,
    history,
    ...(options.externalJobId ? { externalJobId: options.externalJobId } : {}),
    ...(detail && (to === "failed" || needsOperator(to)) ? { error: detail } : {}),
    ...(to === "running" && !entry.startedAt ? { startedAt: at } : {}),
    ...(isTerminal(to) ? { finishedAt: at } : {}),
    // A retry starts a fresh attempt, so the previous failure text must not
    // linger and describe work that has since been redone.
    ...(to === "pending" ? { error: undefined, finishedAt: undefined } : {}),
  };
}

/**
 * What a restart should do with an entry found mid-flight (FR-3, FR-5, FR-11).
 *
 * The distinction the whole spec turns on: an entry with a backend job id can
 * be *asked* what happened, so it is reconciled. An entry that was submitting
 * when the process died cannot — the backend may or may not have accepted it,
 * and there is no safe way to find out from here.
 */
export function reconcileState(entry: TaskEntry): TaskState | null {
  switch (entry.state) {
    case "submitting":
      // FR-11. Never `pending`: that would auto-resubmit a job the backend may
      // already be running.
      return "submission_unknown";
    case "submitted":
    case "running":
    case "cancel_requested":
      // FR-4 when we have an id to poll, FR-5 when we do not.
      return entry.externalJobId ? "reconciling" : "interrupted";
    case "reconciling":
      // Interrupted during a previous reconcile; try again if we still can.
      return entry.externalJobId ? "reconciling" : "interrupted";
    case "pending":
    case "retry_pending":
      // Nothing was submitted, so resuming costs nothing and risks nothing.
      return null;
    default:
      return null;
  }
}

export function entryIsActive(entry: TaskEntry): boolean {
  return isActive(entry.state);
}

/** Summary counts for the recovery panel and for status derivation. */
export function summarise(entries: readonly TaskEntry[]): {
  total: number;
  active: number;
  completed: number;
  failed: number;
  needsOperator: number;
} {
  return {
    total: entries.length,
    active: entries.filter((e) => isActive(e.state)).length,
    completed: entries.filter((e) => e.state === "completed").length,
    failed: entries.filter((e) => e.state === "failed").length,
    needsOperator: entries.filter((e) => needsOperator(e.state)).length,
  };
}

/**
 * The task's own state, derived from its entries.
 *
 * Order matters: anything needing a human outranks a failure, which outranks
 * work still in progress. A task is only `completed` when nothing is left.
 */
export function deriveTaskState(entries: readonly TaskEntry[]): TaskState {
  if (!entries.length) return "completed";
  if (entries.some((e) => needsOperator(e.state))) return "interrupted";
  if (entries.some((e) => isActive(e.state))) {
    return entries.some((e) => e.state === "cancel_requested") ? "cancel_requested" : "running";
  }
  if (entries.some((e) => e.state === "failed")) return "failed";
  if (entries.every((e) => e.state === "cancelled")) return "cancelled";
  return "completed";
}
