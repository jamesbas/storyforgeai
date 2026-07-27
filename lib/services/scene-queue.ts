import { generateSceneMedia } from "@/lib/services/media-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { getLlmRuntimeStatus, unloadPlanningModel } from "@/lib/services/llm-runtime-service";
import { config } from "@/lib/config";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

/**
 * Sequential scene generation queue.
 *
 * WanGP runs one generation at a time, so a "generate everything" button cannot
 * simply fan out. Two further constraints make a server-side queue the right
 * shape rather than a loop in the browser:
 *
 *  - A full project is many minutes of GPU work. Driving it from the page means
 *    closing the tab abandons the run.
 *  - The `reuse_end_frame` and `continue_video` continuity modes read the
 *    previous scene's finished attempt, so scenes must complete strictly in
 *    order. Concurrency would silently degrade them to plain cuts.
 *
 * The design follows the single-concurrency queue pattern: one worker, an
 * in-process queue, and clients polling a status endpoint.
 */

export type SceneQueueState = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SceneQueueEntry = {
  projectId: string;
  sceneId: string;
  sceneNumber: number;
  state: SceneQueueState;
  error?: string;
  /** How many times this scene has been attempted, including retries. */
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
};

type QueueStore = {
  entries: SceneQueueEntry[];
  running: boolean;
  cancelRequested: Set<string>;
};

const globalRef = globalThis as unknown as { __storyforgeSceneQueue?: QueueStore };

function store(): QueueStore {
  globalRef.__storyforgeSceneQueue ??= { entries: [], running: false, cancelRequested: new Set() };
  return globalRef.__storyforgeSceneQueue;
}

/** Queue snapshot for one project, in scene order. */
export function getQueue(projectId: string): {
  entries: SceneQueueEntry[];
  active: boolean;
  remaining: number;
} {
  const entries = store()
    .entries.filter((entry) => entry.projectId === projectId)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  return {
    entries,
    active: entries.some((e) => e.state === "pending" || e.state === "running"),
    remaining: entries.filter((e) => e.state === "pending" || e.state === "running").length,
  };
}

/**
 * Queue every scene that has no generated media yet.
 *
 * Already-generated scenes are skipped so the button is safe to press twice;
 * `regenerateAll` forces the whole storyboard instead.
 */
export async function enqueueProjectScenes(
  projectId: string,
  options: { includeGenerated?: boolean } = {},
): Promise<SceneQueueEntry[]> {
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");

  const state = store();
  const alreadyQueued = new Set(
    state.entries
      .filter(
        (e) => e.projectId === projectId && (e.state === "pending" || e.state === "running"),
      )
      .map((e) => e.sceneId),
  );

  const queued: SceneQueueEntry[] = [];
  for (const scene of record.storyboard.scenes) {
    if (alreadyQueued.has(scene.id)) continue;
    const hasMedia = (record.attempts?.[scene.id] ?? []).length > 0;
    if (hasMedia && !options.includeGenerated) continue;

    const entry: SceneQueueEntry = {
      projectId,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      state: "pending",
      attempts: 0,
    };
    state.entries.push(entry);
    queued.push(entry);
  }

  if (queued.length === 0) return [];

  logEvent("scene_queue.enqueued", { projectId, scenes: queued.length });
  await freeGpuForGeneration();
  void drain();
  return queued;
}

/**
 * Evict the planning model before a batch run.
 *
 * A local LLM and the diffusion models cannot share a single consumer GPU. When
 * they overlap, WanGP does not fail cleanly: it thrashes while swapping the
 * image and video models through what little VRAM is left, and scenes die
 * partway with CUDA faults. Freeing the card up front is what makes an
 * unattended batch survive.
 */
async function freeGpuForGeneration(): Promise<void> {
  if (!config.llmRuntime.unloadBeforeBatch) return;
  try {
    const status = await getLlmRuntimeStatus();
    if (!status.enabled || !status.reachable || status.loadedModels.length === 0) return;
    await unloadPlanningModel();
    logEvent("scene_queue.gpu_freed", { unloaded: status.loadedModels });
  } catch {
    // Best effort. If LM Studio cannot be reached the batch still runs; it may
    // simply be slower or fail on memory, which the retry then covers.
  }
}

/** Ask for the remaining scenes of a project to be abandoned. */
export function cancelQueue(projectId: string): number {
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
  logEvent("scene_queue.cancelled", { projectId, cancelled });
  return cancelled;
}

/** Drop finished entries so a repeated run starts from a clean slate. */
export function clearFinished(projectId: string): void {
  const state = store();
  state.entries = state.entries.filter(
    (entry) =>
      entry.projectId !== projectId || entry.state === "pending" || entry.state === "running",
  );
}

/**
 * Faults that are worth another attempt.
 *
 * These are all symptoms of the GPU being contended or fragmented rather than
 * of a bad request: the identical settings usually succeed once memory frees
 * up. A malformed prompt or a missing reference file will not match, and fails
 * immediately as it should.
 */
const TRANSIENT_FAULT =
  /cuda|out of memory|resource already mapped|insufficient|unsufficient|generation in progress|allocat/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single worker. Runs until the queue empties, one scene at a time, in scene
 * order so continuity modes can read the previous scene's finished attempt.
 */
async function drain(): Promise<void> {
  const state = store();
  if (state.running) return;
  state.running = true;

  try {
    let firstScene = true;
    for (;;) {
      const next = state.entries
        .filter((entry) => entry.state === "pending")
        .sort((a, b) => a.sceneNumber - b.sceneNumber)[0];
      if (!next) break;

      if (state.cancelRequested.has(next.projectId)) {
        next.state = "cancelled";
        next.finishedAt = new Date().toISOString();
        continue;
      }

      // Let WanGP release the previous scene's model before the next one loads.
      // Back-to-back submissions are what push a tight card into CUDA faults.
      if (!firstScene && config.sceneQueue.settleDelayMs > 0) {
        await sleep(config.sceneQueue.settleDelayMs);
      }
      firstScene = false;

      next.state = "running";
      next.startedAt = new Date().toISOString();
      const maxAttempts = 1 + Math.max(0, config.sceneQueue.retryAttempts);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        next.attempts = attempt;
        try {
          await generateSceneMedia(next.projectId, next.sceneId);
          next.state = "completed";
          next.error = undefined;
          break;
        } catch (err) {
          const message =
            err instanceof NotFoundError || err instanceof ValidationError
              ? err.message
              : err instanceof Error
                ? err.message
                : "Generation failed";
          const retryable = attempt < maxAttempts && TRANSIENT_FAULT.test(message);

          logEvent("scene_queue.failed", {
            projectId: next.projectId,
            sceneId: next.sceneId,
            attempt,
            retrying: retryable,
            error: message,
          });

          if (!retryable) {
            // One scene failing must not abandon the rest: a transient fault on
            // scene 3 should not cost scenes 4 through 10.
            next.state = "failed";
            next.error = message;
            break;
          }
          await sleep(config.sceneQueue.retryDelayMs);
        }
      }
      next.finishedAt = new Date().toISOString();
    }
  } finally {
    state.running = false;
    for (const projectId of state.cancelRequested) {
      const stillQueued = state.entries.some(
        (e) => e.projectId === projectId && (e.state === "pending" || e.state === "running"),
      );
      if (!stillQueued) state.cancelRequested.delete(projectId);
    }
  }
}

/** Test seam: drop all queue state. */
export function resetSceneQueue(): void {
  globalRef.__storyforgeSceneQueue = {
    entries: [],
    running: false,
    cancelRequested: new Set(),
  };
}

/** Test seam: resolve once the queue has drained. */
export async function waitForQueue(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = store();
    const busy =
      state.running || state.entries.some((e) => e.state === "pending" || e.state === "running");
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Scene queue did not drain in time");
}
