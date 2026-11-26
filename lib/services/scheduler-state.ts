import type { RunType } from "@/lib/schemas/schedule";
import { logEvent } from "@/lib/telemetry";

/**
 * The Scheduler's in-memory runtime, shared without imports.
 *
 * Kept apart from the scheduler service on purpose: the route guard and
 * `project-service` both need to read it, and the service imports both queues,
 * which import `project-service` — reading it from there would close the cycle.
 *
 * Pinned to `globalThis` like the queues, so HMR keeps one worker.
 */

export type PreparingPhase = "waiting" | "restarting_wangp" | "loading_planning_model" | "running";

export type SchedulerCurrent = {
  itemId: string;
  projectId: string;
  runType: RunType;
  /** "Video — Night Harbor" */
  label: string;
  position: number;
  total: number;
  phase: PreparingPhase;
  phaseStartedAt: string;
  startedAt: string;
  durableTaskId?: string;
};

export type SchedulerRuntime = {
  /** The worker loop's lock, as `running` is for the queues. */
  loopActive: boolean;
  /** The item the worker has dispatched or is preparing; null between items. */
  current: SchedulerCurrent | null;
  /** What the worker is waiting behind, when a run it did not start holds the GPU. */
  waitingFor: string | null;
  /** The run type of the last item dispatched this session (FR-15). */
  lastRunType: RunType | null;
  cancelRequested: boolean;
  /** Projects whose `full_auto` media start is suppressed (FR-16). */
  suppressAutoStart: Set<string>;
  /** Projects where the suppression actually fired, for the item's summary. */
  autoStartSuppressed: Set<string>;
};

const globalRef = globalThis as unknown as { __storyforgeScheduler?: SchedulerRuntime };

export function schedulerRuntime(): SchedulerRuntime {
  globalRef.__storyforgeScheduler ??= {
    loopActive: false,
    current: null,
    waitingFor: null,
    lastRunType: null,
    cancelRequested: false,
    suppressAutoStart: new Set(),
    autoStartSuppressed: new Set(),
  };
  return globalRef.__storyforgeScheduler;
}

/** The item the Scheduler is running right now, or null. */
export function runningScheduledItem(): SchedulerCurrent | null {
  return schedulerRuntime().current;
}

/**
 * Whether a scheduled storyboard run owns this project, so `full_auto` must not
 * queue its media (decision D-7). Records the hit so the item can say so.
 */
export function schedulerSuppressesAutoStart(projectId: string): boolean {
  const runtime = schedulerRuntime();
  if (!runtime.suppressAutoStart.has(projectId)) return false;
  runtime.autoStartSuppressed.add(projectId);
  logEvent("scheduler.autostart_suppressed", { projectId });
  return true;
}

/** Test seam. */
export function resetSchedulerRuntime(): void {
  globalRef.__storyforgeScheduler = undefined;
}
