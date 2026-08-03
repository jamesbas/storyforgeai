import {
  generateSceneMedia,
  canRunPhased,
  generateProjectMediaPhased,
  regenerateSceneVideo,
} from "@/lib/services/media-service";
import type { PhaseName } from "@/lib/services/media-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { getLlmRuntimeStatus, unloadPlanningModel } from "@/lib/services/llm-runtime-service";
import { generationStages, DEFAULT_SCENE_CONTINUITY } from "@/lib/types";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
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

/**
 * How much of a scene an entry re-renders.
 *
 * `video` reuses the keyframes already on the record. Changing a video prompt
 * or a motion LoRA does not change the frames, and a full pass would re-render
 * both of them to arrive back where it started.
 */
export type SceneQueueScope = "full" | "video";

export type SceneQueueEntry = {
  projectId: string;
  sceneId: string;
  sceneNumber: number;
  state: SceneQueueState;
  scope: SceneQueueScope;
  error?: string;
  /** How many times this scene has been attempted, including retries. */
  attempts: number;
  /**
   * Which stage a phased batch is in. Absent for scene-at-a-time runs, where a
   * scene simply runs to completion.
   */
  phase?: PhaseName;
  startedAt?: string;
  finishedAt?: string;
};

/**
 * How far through the current phase a batch is.
 *
 * A phased run spends upwards of an hour inside one phase, and the per-scene
 * chips do not move for any of it — so without this the UI is indistinguishable
 * from a stalled job.
 */
export type PhaseProgress = { phase: PhaseName; completed: number; total: number };

type QueueStore = {
  entries: SceneQueueEntry[];
  running: boolean;
  cancelRequested: Set<string>;
  phases: Map<string, PhaseProgress>;
};

const globalRef = globalThis as unknown as { __storyforgeSceneQueue?: QueueStore };

function store(): QueueStore {
  globalRef.__storyforgeSceneQueue ??= {
    entries: [],
    running: false,
    cancelRequested: new Set(),
    phases: new Map(),
  };
  // A store created before `phases` existed would otherwise be missing it.
  globalRef.__storyforgeSceneQueue.phases ??= new Map();
  return globalRef.__storyforgeSceneQueue;
}

/** Queue snapshot for one project, in scene order. */
export function getQueue(projectId: string): {
  entries: SceneQueueEntry[];
  active: boolean;
  remaining: number;
  phase?: PhaseProgress;
} {
  const state = store();
  const entries = state.entries
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  const active = entries.some((e) => e.state === "pending" || e.state === "running");
  return {
    entries,
    active,
    remaining: entries.filter((e) => e.state === "pending" || e.state === "running").length,
    ...(active ? { phase: state.phases.get(projectId) } : {}),
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
  // SPEC-008 §17.7: exactly one drainer owns a project. Durable tasks take
  // this queue out of service rather than running alongside it.
  if (config.flags.durableTasks) {
    throw new ValidationError("Durable tasks are enabled; use the task queue for this project.");
  }
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");
  if (!generationStages(record.project.generationMode).keyframes) {
    throw new ValidationError(
      "This project's generation mode is Storyboard only, so no media is rendered. " +
        "Change it on the Storyboard screen to render keyframes or clips.",
    );
  }

  const state = store();
  const alreadyQueued = new Set(
    state.entries
      .filter(
        (e) => e.projectId === projectId && (e.state === "pending" || e.state === "running"),
      )
      .map((e) => e.sceneId),
  );

  const queued: SceneQueueEntry[] = [];
  const stages = generationStages(record.project.generationMode);
  for (const scene of record.storyboard.scenes) {
    if (alreadyQueued.has(scene.id)) continue;
    // A batch that died after banking keyframes leaves attempts with no clip.
    // Counting those as done would strand the scene one step short of finished.
    const done = (record.attempts?.[scene.id] ?? []).some(
      (attempt) => !stages.video || Boolean(attempt.videoPath),
    );
    if (done && !options.includeGenerated) continue;

    const entry: SceneQueueEntry = {
      projectId,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      state: "pending",
      scope: "full",
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
 * Which scenes a video-only rerun actually has to cover.
 *
 * On `continue_video` each clip is built from the previous scene's *clip*, so
 * re-rendering one in the middle leaves every scene after it continuing from
 * something that no longer exists. The selection is therefore extended forward
 * from the earliest scene chosen — refusing outright would leave that mode with
 * no way to do this at all, and honouring the selection literally would break
 * the chain silently, which is worse than either.
 *
 * The frame-based modes chain keyframes rather than clips, and a video-only
 * rerun does not touch those, so the selection stands as given.
 */
export function videoRerunScope(
  record: ProjectRecord,
  sceneIds: readonly string[],
): { sceneIds: string[]; cascaded: boolean } {
  const scenes = record.storyboard?.scenes ?? [];
  const chosen = new Set(sceneIds);
  const selected = scenes.filter((scene) => chosen.has(scene.id));
  if (selected.length === 0) return { sceneIds: [], cascaded: false };

  if ((record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) !== "continue_video") {
    return { sceneIds: selected.map((scene) => scene.id), cascaded: false };
  }

  const from = Math.min(...selected.map((scene) => scene.sceneNumber));
  const forward = scenes.filter((scene) => scene.sceneNumber >= from);
  return {
    sceneIds: forward.map((scene) => scene.id),
    cascaded: forward.length > selected.length,
  };
}

/**
 * Queue a clip-only rerun for the given scenes, or all of them when none are named.
 *
 * No phasing: every job in the batch runs on the same video model, so there is
 * nothing to group and the scene-at-a-time worker is already optimal.
 */
export async function enqueueVideoRerun(
  projectId: string,
  sceneIds?: readonly string[],
): Promise<{ entries: SceneQueueEntry[]; cascaded: boolean }> {
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before media");
  if (!generationStages(record.project.generationMode).video) {
    throw new ValidationError(
      "This project's generation mode does not render clips. Change it to Video segments first.",
    );
  }

  const all = record.storyboard.scenes.map((scene) => scene.id);
  const scope = videoRerunScope(record, sceneIds?.length ? sceneIds : all);

  const state = store();
  const alreadyQueued = new Set(
    state.entries
      .filter((e) => e.projectId === projectId && (e.state === "pending" || e.state === "running"))
      .map((e) => e.sceneId),
  );

  const byId = new Map(record.storyboard.scenes.map((scene) => [scene.id, scene]));
  const queued: SceneQueueEntry[] = [];
  for (const sceneId of scope.sceneIds) {
    if (alreadyQueued.has(sceneId)) continue;
    const scene = byId.get(sceneId);
    if (!scene) continue;
    // Nothing to reuse means nothing to rerun; a full pass is the right answer.
    if (!(record.attempts?.[sceneId] ?? []).some((attempt) => attempt.startImagePath)) continue;

    const entry: SceneQueueEntry = {
      projectId,
      sceneId,
      sceneNumber: scene.sceneNumber,
      state: "pending",
      scope: "video",
      attempts: 0,
    };
    state.entries.push(entry);
    queued.push(entry);
  }

  if (queued.length === 0) {
    throw new ValidationError(
      "None of those scenes have keyframes to rebuild a clip from. Generate their media first.",
    );
  }

  logEvent("scene_queue.enqueued", { projectId, scenes: queued.length, scope: "video" });
  await freeGpuForGeneration();
  void drain();
  return { entries: queued, cascaded: scope.cascaded };
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
 * Two families, both symptoms of the environment rather than of a bad request.
 * GPU pressure — CUDA faults, out-of-memory — usually succeeds on a second pass
 * once memory frees up. Transport failures are the MCP session dropping under a
 * long batch; the client reconnects, so the same settings go straight through.
 * A malformed prompt or a missing reference file matches neither and fails
 * immediately as it should.
 */
const TRANSIENT_FAULT =
  /cuda|out of memory|resource already mapped|insufficient|unsufficient|generation in progress|allocat|fetch failed|econnreset|econnrefused|etimedout|epipe|socket hang up|network|terminated/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a project's pending scenes grouped by model rather than by scene.
 *
 * Returns false when the batch is not a fit for phasing, leaving the caller to
 * fall back to the scene-at-a-time worker.
 */
async function drainPhased(projectId: string, pending: SceneQueueEntry[]): Promise<boolean> {
  const record = await getProjectRecord(projectId);
  const sceneIds = pending.map((entry) => entry.sceneId);
  if (!(await canRunPhased(record, sceneIds))) return false;

  const state = store();
  const cancelled = () => state.cancelRequested.has(projectId);

  for (const entry of pending) {
    entry.state = "running";
    entry.attempts = 1;
    entry.startedAt = new Date().toISOString();
  }

  /**
   * Retry a single job rather than the batch.
   *
   * Model swapping is exactly what provokes transient CUDA and out-of-memory
   * faults, and a phased run does more of it than any other path. Retrying the
   * one job keeps a blip from costing every scene behind it.
   */
  const runStep = async <T>(step: () => Promise<T>): Promise<T> => {
    const maxAttempts = 1 + Math.max(0, config.sceneQueue.retryAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await step();
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const retryable = attempt < maxAttempts && TRANSIENT_FAULT.test(message);
        logEvent("scene_queue.failed", {
          projectId,
          sceneId: "batch",
          attempt,
          retrying: retryable,
          error: message,
        });
        if (!retryable) throw err;
        await sleep(config.sceneQueue.retryDelayMs);
      }
    }
    throw lastError;
  };

  try {
    await generateProjectMediaPhased(projectId, sceneIds, {
      shouldCancel: cancelled,
      runStep,
      onPhase: (phase, total) => {
        state.phases.set(projectId, { phase, completed: 0, total });
        for (const entry of pending) if (entry.state === "running") entry.phase = phase;
      },
      onPhaseProgress: (completed) => {
        const current = state.phases.get(projectId);
        if (current) state.phases.set(projectId, { ...current, completed });
      },
      // Scenes finish one at a time during the final phase, so the storyboard
      // fills in as clips land rather than all at once at the end.
      onSceneComplete: (sceneId) => {
        const entry = pending.find((e) => e.sceneId === sceneId);
        if (!entry) return;
        entry.state = "completed";
        entry.phase = undefined;
        entry.finishedAt = new Date().toISOString();
      },
      onSceneFailed: (sceneId, error) => {
        const entry = pending.find((e) => e.sceneId === sceneId);
        if (!entry) return;
        entry.state = "failed";
        entry.error = error;
        entry.phase = undefined;
        entry.finishedAt = new Date().toISOString();
      },
    });

    // A cancelled or short-circuited run leaves scenes still marked running.
    for (const entry of pending) {
      if (entry.state !== "running") continue;
      entry.state = cancelled() ? "cancelled" : "failed";
      entry.error = cancelled() ? undefined : "Batch ended before this scene finished";
      entry.phase = undefined;
      entry.finishedAt = new Date().toISOString();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Batch generation failed";
    logEvent("scene_queue.failed", { projectId, sceneId: "batch", attempt: 1, retrying: false, error: message });
    for (const entry of pending) {
      if (entry.state !== "running") continue;
      entry.state = "failed";
      entry.error = message;
      entry.phase = undefined;
      entry.finishedAt = new Date().toISOString();
    }
  }

  return true;
}

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

      // Grouping a whole project by model saves a model load per job, and a load
      // costs more than the job. Only worth it for a real batch, so a single
      // pending scene still runs the immediate path below. A clip-only batch is
      // already one model throughout, so there is nothing for phasing to group.
      const pending = state.entries.filter(
        (entry) => entry.projectId === next.projectId && entry.state === "pending",
      );
      if (
        next.scope !== "video" &&
        pending.length > 1 &&
        (await drainPhased(
          next.projectId,
          pending.filter((entry) => entry.scope !== "video"),
        ))
      ) {
        firstScene = false;
        continue;
      }

      // Let WanGP release the previous scene's model before the next one loads.
      // Back-to-back submissions are what push a tight card into CUDA faults.
      if (!firstScene && config.sceneQueue.settleDelayMs > 0) {
        await sleep(config.sceneQueue.settleDelayMs);
      }
      // Not only on the first scene: QC at the end of every scene is an LLM
      // round-trip, so the planning model is back on the card by the time the
      // next scene wants it. Clearing once at enqueue only helped scene one.
      if (!firstScene) await freeGpuForGeneration();
      firstScene = false;

      next.state = "running";
      next.startedAt = new Date().toISOString();
      const maxAttempts = 1 + Math.max(0, config.sceneQueue.retryAttempts);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        next.attempts = attempt;
        try {
          if (next.scope === "video") await regenerateSceneVideo(next.projectId, next.sceneId);
          else await generateSceneMedia(next.projectId, next.sceneId);
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
    // A stale phase would keep reading as though a batch were still working.
    state.phases.clear();
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
    phases: new Map(),
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
