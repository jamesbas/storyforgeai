import {
  generateArtDirectionPlan,
  generateCinematographyPlan,
  generateDirectorialPlan,
  generateStoryboard,
  generateWorldBible,
} from "@/lib/services/project-service";
import { ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import { config } from "@/lib/config";
import type { AgentProgress, ProgressReporter } from "@/lib/agents/types";

/**
 * Sequential canvas planning queue.
 *
 * "Run the crew" used to be a loop in the browser: one fetch per agent, in
 * order, driven by the page. Every agent is minutes of work on a local model,
 * so the run outlived any reasonable attention span — and a refresh or a
 * navigation abandoned the rest of the queue silently. The agent still running
 * finished server-side and reported itself, which made the screen look busy
 * while nothing further was ever going to happen.
 *
 * Same shape as the scene queue, for the same reasons: one worker, an
 * in-process queue, clients polling a status endpoint. Sequencing is not a
 * nicety here either — each plan is written against whichever plans already
 * exist, so running them concurrently would quietly produce a Cinematographer
 * that never saw the Director.
 *
 * Survives navigation and browser restarts. It does not survive restarting the
 * Node process, which is the same bargain the project store itself makes.
 */

export type CanvasRunState = "pending" | "running" | "completed" | "failed" | "cancelled";

export type CanvasRunEntry = {
  projectId: string;
  /** Matches the canvas card's `key`, so the UI can light the right one. */
  agentKey: string;
  agentName: string;
  state: CanvasRunState;
  /** Where a long agent has got to. Only meaningful while it is running. */
  progress?: AgentProgress;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

type QueueStore = {
  entries: CanvasRunEntry[];
  running: boolean;
  cancelRequested: Set<string>;
};

const globalRef = globalThis as unknown as { __storyforgeCanvasQueue?: QueueStore };

function store(): QueueStore {
  globalRef.__storyforgeCanvasQueue ??= {
    entries: [],
    running: false,
    cancelRequested: new Set(),
  };
  return globalRef.__storyforgeCanvasQueue;
}

/**
 * The plans that feed the storyboard, in the order they build on one another.
 *
 * Variant Explorer is absent because choosing a direction is a human decision.
 * The Storyboard Artist is optional and always last: it folds in whichever
 * plans exist at the moment it runs.
 */
type CanvasRunner = {
  agentKey: string;
  agentName: string;
  /** Long agents report sub-steps; short ones ignore the reporter. */
  run: (projectId: string, onProgress?: ProgressReporter) => Promise<unknown>;
};

const CORE_RUNNERS = [
  { agentKey: "world", agentName: "World Builder", run: generateWorldBible },
  { agentKey: "director", agentName: "Director", run: generateDirectorialPlan },
  { agentKey: "cinematographer", agentName: "Cinematographer", run: generateCinematographyPlan },
  { agentKey: "art", agentName: "Art Director", run: generateArtDirectionPlan },
] as const satisfies readonly CanvasRunner[];

const STORYBOARD_RUNNER = {
  agentKey: "storyboard",
  agentName: "Storyboard Artist",
  run: generateStoryboard,
} as const satisfies CanvasRunner;

function runnerFor(agentKey: string) {
  return [...CORE_RUNNERS, STORYBOARD_RUNNER].find((r) => r.agentKey === agentKey) ?? null;
}

/** Queue snapshot for one project, in run order. */
export function getCanvasQueue(projectId: string): {
  entries: CanvasRunEntry[];
  active: boolean;
  done: number;
  total: number;
} {
  const entries = store().entries.filter((entry) => entry.projectId === projectId);
  const active = entries.some((e) => e.state === "pending" || e.state === "running");
  return {
    entries,
    active,
    done: entries.filter((e) => e.state === "completed").length,
    total: entries.length,
  };
}

/** Drop finished entries so a repeated run starts from a clean slate. */
export function clearFinishedCanvasRun(projectId: string): void {
  const state = store();
  state.entries = state.entries.filter(
    (entry) =>
      entry.projectId !== projectId || entry.state === "pending" || entry.state === "running",
  );
}

/** Ask for the remaining agents of a project to be abandoned. */
export function cancelCanvasRun(projectId: string): number {
  const state = store();
  state.cancelRequested.add(projectId);
  let cancelled = 0;
  for (const entry of state.entries) {
    if (entry.projectId === projectId && entry.state === "pending") {
      entry.state = "cancelled";
      entry.finishedAt = new Date().toISOString();
      cancelled += 1;
    }
  }
  logEvent("canvas_queue.cancelled", { projectId, cancelled });
  return cancelled;
}

/** Queue the crew, and start the worker if it is not already going. */
export function enqueueCanvasRun(
  projectId: string,
  options: { includeStoryboard?: boolean } = {},
): CanvasRunEntry[] {
  const state = store();
  // SPEC-008 §17.7: exactly one drainer owns a project. When durable tasks are
  // on, this queue must not enqueue at all, or two workers would run the same
  // agents against the same record.
  if (config.flags.durableTasks) {
    throw new ValidationError("Durable tasks are enabled; use the task queue for this project.");
  }
  if (getCanvasQueue(projectId).active) {
    throw new ValidationError("This project already has a plan run in progress.");
  }

  clearFinishedCanvasRun(projectId);
  state.cancelRequested.delete(projectId);

  const wanted = [...CORE_RUNNERS, ...(options.includeStoryboard ? [STORYBOARD_RUNNER] : [])];
  const queued: CanvasRunEntry[] = wanted.map((runner) => ({
    projectId,
    agentKey: runner.agentKey,
    agentName: runner.agentName,
    state: "pending" as const,
  }));
  state.entries.push(...queued);
  logEvent("canvas_queue.enqueued", { projectId, agents: queued.length });

  void drain();
  return queued;
}

/**
 * One worker for the whole process.
 *
 * `running` is the lock. Planning calls are already serialised inside the
 * provider, but a second worker would still interleave two projects' agents and
 * make either one's plans read as though the other's had never happened.
 */
async function drain(): Promise<void> {
  const state = store();
  if (state.running) return;
  state.running = true;

  try {
    for (;;) {
      const next = state.entries.find((entry) => entry.state === "pending");
      if (!next) break;

      if (state.cancelRequested.has(next.projectId)) {
        next.state = "cancelled";
        next.finishedAt = new Date().toISOString();
        continue;
      }

      const runner = runnerFor(next.agentKey);
      if (!runner) {
        next.state = "failed";
        next.error = `No runner for ${next.agentKey}`;
        next.finishedAt = new Date().toISOString();
        continue;
      }

      next.state = "running";
      next.startedAt = new Date().toISOString();
      try {
        // A late report from an agent that has already finished would leave a
        // completed row claiming to be mid-scene, so only the running one takes it.
        await runner.run(next.projectId, (progress) => {
          if (next.state === "running") next.progress = progress;
        });
        next.state = "completed";
        next.finishedAt = new Date().toISOString();
        next.progress = undefined;
      } catch (err) {
        next.state = "failed";
        next.error = err instanceof Error ? err.message : "Failed";
        next.finishedAt = new Date().toISOString();
        next.progress = undefined;
        logEvent("canvas_queue.failed", { projectId: next.projectId, agent: next.agentKey });
        // Stop this project rather than pressing on: a later plan written
        // against a missing earlier one is not what was asked for.
        cancelCanvasRun(next.projectId);
      }
    }
  } finally {
    state.running = false;
  }
}

/** Test seam. */
export function resetCanvasQueue(): void {
  globalRef.__storyforgeCanvasQueue = {
    entries: [],
    running: false,
    cancelRequested: new Set(),
  };
}
