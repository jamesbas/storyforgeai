import { logEvent } from "@/lib/telemetry";
import { ValidationError } from "@/lib/errors";
import {
  generateArtDirectionPlan,
  generateCinematographyPlan,
  generateDirectorialPlan,
  generateStoryboard,
  generateWorldBible,
} from "@/lib/services/project-service";
import { createTask, listTasks, requestCancel } from "@/lib/tasks/task-service";
import { drainTask, type RunOutcome } from "@/lib/tasks/drainer";
import { isTerminal, type Task } from "@/lib/schemas/tasks";

/**
 * The canvas run on durable tasks (SPEC-008 slice 3).
 *
 * Chosen as the first migration because it is the simpler of the two queues:
 * the agents are LLM calls with no external job id, so there is no ambiguous
 * submission window to reason about. If a plan run is interrupted it can always
 * be safely rerun — which makes it a good place to prove the storage, the lease
 * and the reconciliation before the scene queue, where a wrong answer costs
 * GPU minutes.
 */

const CORE_RUNNERS = [
  { agentKey: "world", agentName: "World Builder", run: generateWorldBible },
  { agentKey: "director", agentName: "Director", run: generateDirectorialPlan },
  { agentKey: "cinematographer", agentName: "Cinematographer", run: generateCinematographyPlan },
  { agentKey: "art", agentName: "Art Director", run: generateArtDirectionPlan },
] as const;

const STORYBOARD_RUNNER = {
  agentKey: "storyboard",
  agentName: "Storyboard Artist",
  run: generateStoryboard,
} as const;

function runnerFor(agentKey: string) {
  return [...CORE_RUNNERS, STORYBOARD_RUNNER].find((r) => r.agentKey === agentKey);
}

export async function activeCanvasTask(projectId: string): Promise<Task | undefined> {
  return (await listTasks(projectId)).find((t) => t.kind === "canvas_run" && !isTerminal(t.state));
}

export async function enqueueDurableCanvasRun(
  projectId: string,
  options: { includeStoryboard?: boolean; correlationId?: string } = {},
): Promise<Task> {
  if (await activeCanvasTask(projectId)) {
    throw new ValidationError("This project already has a plan run in progress.");
  }

  const wanted = [...CORE_RUNNERS, ...(options.includeStoryboard ? [STORYBOARD_RUNNER] : [])];
  const task = await createTask(
    projectId,
    "canvas_run",
    wanted.map((runner, index) => ({
      ref: runner.agentKey,
      label: runner.agentName,
      order: index,
    })),
    { correlationId: options.correlationId, phase: "plan" },
  );

  logEvent("canvas_queue.enqueued", { projectId, agents: task.entries.length, durable: true });
  void drainDurableCanvasRun(projectId, task.id);
  return task;
}

export async function drainDurableCanvasRun(projectId: string, taskId: string): Promise<void> {
  await drainTask(projectId, taskId, {
    // One failure abandons the rest, matching the legacy behaviour: the later
    // plans build on the earlier ones, so continuing produces a plan set that
    // silently disagrees with itself.
    abortOnFailure: true,
    runEntry: async (entry): Promise<RunOutcome> => {
      const runner = runnerFor(entry.ref);
      if (!runner) return { kind: "failed", detail: `No runner for ${entry.ref}`, retryable: false };
      try {
        await runner.run(projectId);
        return { kind: "completed" };
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed";
        logEvent("canvas_queue.failed", { projectId, agentKey: entry.ref, error: detail });
        return { kind: "failed", detail, retryable: false };
      }
    },
    // A planning agent has no external job, so an interrupted one cannot be
    // polled. Rerunning it is safe and cheap, so reconciliation hands it back
    // as unknown and the operator retries.
    reconcileEntry: async () => "unknown",
  });
}

export async function cancelDurableCanvasRun(projectId: string): Promise<number> {
  const task = await activeCanvasTask(projectId);
  if (!task) return 0;
  return requestCancel(projectId, task.id);
}
