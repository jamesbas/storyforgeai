import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { ConflictError } from "@/lib/errors";
import { repository } from "@/lib/db/store";
import { logEvent } from "@/lib/telemetry";
import { listAgentRuns } from "@/lib/services/agent-runs";
import { activeCanvasProjects } from "@/lib/services/canvas-queue";
import { activeSceneQueueProjects } from "@/lib/services/scene-queue";
import { activeSceneCheckProjects } from "@/lib/services/scene-check-service";
import { drainingProjects } from "@/lib/tasks/drainer";
import { runningScheduledItem } from "@/lib/services/scheduler-state";

/**
 * Is anything using the GPU right now, in any project? (FR-17)
 *
 * StoryForge has no single owner of the GPU: planning agents, the canvas
 * queue, the scene queue, scene checks, durable tasks and single-scene renders
 * each run on their own. The Scheduler waits for all of them to go quiet before
 * it starts an item, and this is the one place that knows the full list.
 */

export type BusyKind =
  | "agent"
  | "canvas"
  | "scene_queue"
  | "scene_check"
  | "durable"
  | "single_render";

export type BusyReason = { kind: BusyKind; projectId: string; label: string };

type SingleRender = { projectId: string; label: string; startedAt: string };

const globalRef = globalThis as unknown as { __storyforgeSingleRenders?: Map<string, SingleRender> };

function singleRenders(): Map<string, SingleRender> {
  globalRef.__storyforgeSingleRenders ??= new Map();
  return globalRef.__storyforgeSingleRenders;
}

/**
 * Record a single-scene WanGP job (a render, keyframe preview, face swap…) for
 * its duration. These ran untracked before the Scheduler needed to see them.
 */
export async function trackSceneRender<T>(
  projectId: string,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  singleRenders().set(id, { projectId, label, startedAt: new Date().toISOString() });
  try {
    return await task();
  } finally {
    singleRenders().delete(id);
  }
}

export function busyReasons(): BusyReason[] {
  const reasons: BusyReason[] = [];
  for (const run of listAgentRuns()) {
    reasons.push({ kind: "agent", projectId: run.projectId, label: run.agentName });
  }
  for (const projectId of activeCanvasProjects()) {
    reasons.push({ kind: "canvas", projectId, label: "Agentic Canvas run" });
  }
  for (const projectId of activeSceneQueueProjects()) {
    reasons.push({ kind: "scene_queue", projectId, label: "Media generation" });
  }
  for (const projectId of activeSceneCheckProjects()) {
    reasons.push({ kind: "scene_check", projectId, label: "Scene check" });
  }
  if (config.flags.durableTasks) {
    for (const projectId of drainingProjects()) {
      reasons.push({ kind: "durable", projectId, label: "Durable task" });
    }
  }
  for (const render of singleRenders().values()) {
    reasons.push({ kind: "single_render", projectId: render.projectId, label: render.label });
  }
  return reasons;
}

export function isGenerationBusy(): boolean {
  return busyReasons().length > 0;
}

/**
 * One sentence naming what holds the GPU, or null when nothing does.
 *
 * The first reason wins: an agent run and its canvas entry describe the same
 * work, and the agent's own name is the more useful of the two.
 */
export async function describeBusy(): Promise<string | null> {
  const [first] = busyReasons();
  if (!first) return null;
  const record = await repository.get(first.projectId).catch(() => null);
  const title = record?.project.title ?? "another project";
  return `${first.label} — ${title}`;
}

/**
 * Refuse a manual GPU run while the Scheduler has an item running (FR-18).
 *
 * Called from route handlers, never from services: the Scheduler drives the
 * same services directly and must not trip its own guard.
 */
export function assertManualRunAllowed(route: string): void {
  const current = runningScheduledItem();
  if (!current) return;
  logEvent("scheduler.manual_run_refused", { route, itemId: current.itemId });
  throw new ConflictError(
    `The Scheduler is running ${current.label} (item ${current.position} of ${current.total}). ` +
      "Pause the schedule to run something by hand.",
    { scheduler: true },
  );
}

/** Test seam. */
export function resetSingleRenders(): void {
  singleRenders().clear();
}
