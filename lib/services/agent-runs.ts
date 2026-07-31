import { logEvent } from "@/lib/telemetry";

/**
 * Which agent is running, for whom, right now.
 *
 * The Agentic Canvas tracked this in component state, so navigating away and
 * back showed an idle screen while the run was still going on the server — and
 * the buttons unlocked, inviting a second run onto a GPU already busy with the
 * first. Run state has to outlive the component that started it, so it lives
 * here and the UI reads it back.
 *
 * Pinned to `globalThis` for the same reason the scene queue is: Next.js
 * hot-module reload would otherwise hand each route handler a fresh module.
 */
export type AgentRun = {
  projectId: string;
  /** Matches the canvas agent's `key`, so the UI can light the right card. */
  agentKey: string;
  agentName: string;
  startedAt: string;
};

const globalRef = globalThis as unknown as { __storyforgeAgentRuns?: Map<string, AgentRun> };

function store(): Map<string, AgentRun> {
  globalRef.__storyforgeAgentRuns ??= new Map();
  return globalRef.__storyforgeAgentRuns;
}

/** The run in flight for a project, or null when nothing is running. */
export function getAgentRun(projectId: string): AgentRun | null {
  return store().get(projectId) ?? null;
}

/**
 * Record a run for its duration.
 *
 * The entry is cleared in `finally`, so a failed agent does not leave the
 * project looking permanently busy — the failure mode that made the stored
 * project status untrustworthy in the first place.
 */
export async function trackAgentRun<T>(
  projectId: string,
  agentKey: string,
  agentName: string,
  task: () => Promise<T>,
): Promise<T> {
  const runs = store();
  runs.set(projectId, {
    projectId,
    agentKey,
    agentName,
    startedAt: new Date().toISOString(),
  });
  logEvent("agent.run_started", { projectId, agent: agentKey });
  const began = Date.now();
  try {
    return await task();
  } finally {
    runs.delete(projectId);
    logEvent("agent.run_finished", { projectId, agent: agentKey, seconds: Math.round((Date.now() - began) / 1000) });
  }
}

/** Test seam. */
export function resetAgentRuns(): void {
  store().clear();
}
