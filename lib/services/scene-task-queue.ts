import { logEvent } from "@/lib/telemetry";
import { ValidationError } from "@/lib/errors";
import { getProjectRecord } from "@/lib/services/project-service";
import { generateSceneMedia, regenerateSceneVideo } from "@/lib/services/media-service";
import { resumeJob } from "@/lib/services/wangp-service";
import { createTask, listTasks, requestCancel } from "@/lib/tasks/task-service";
import { drainTask, type RunOutcome } from "@/lib/tasks/drainer";
import { isTerminal, type Task, type TaskEntry } from "@/lib/schemas/tasks";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * The scene batch on durable tasks (SPEC-008 slice 4).
 *
 * This is the queue the spec exists for: a scene render is minutes of GPU time
 * and is not idempotent, so a restart must never turn into a second submission.
 * Two mechanisms carry that: the job id is persisted before polling begins, and
 * an entry whose artifact already exists is skipped rather than rerun.
 */

export async function activeSceneTask(projectId: string): Promise<Task | undefined> {
  return (await listTasks(projectId)).find((t) => t.kind === "scene_batch" && !isTerminal(t.state));
}

/**
 * Whether a scene already has the artifact this entry would produce (FR-6).
 *
 * Checked before every run, not just after a restart: it is what makes a resume
 * safe. A scene that finished just before the crash is skipped rather than
 * rendered a second time.
 */
export function sceneAlreadyProduced(record: ProjectRecord, sceneId: string): boolean {
  const attempts = record.attempts?.[sceneId] ?? [];
  return attempts.some((attempt) => Boolean(attempt.videoPath));
}

export async function enqueueDurableSceneBatch(
  projectId: string,
  sceneIds: readonly string[],
  options: { correlationId?: string } = {},
): Promise<Task> {
  if (await activeSceneTask(projectId)) {
    throw new ValidationError("This project already has a generation run in progress.");
  }

  const record = await getProjectRecord(projectId);
  const scenes = record.storyboard?.scenes ?? [];
  const wanted = scenes.filter((scene) => sceneIds.includes(scene.id));
  if (!wanted.length) throw new ValidationError("No scenes to generate.");

  const task = await createTask(
    projectId,
    "scene_batch",
    wanted.map((scene) => ({
      ref: scene.id,
      label: `Scene ${scene.sceneNumber}`,
      order: scene.sceneNumber,
    })),
    { correlationId: options.correlationId },
  );

  logEvent("scene_queue.enqueued", { projectId, scenes: task.entries.length, durable: true });
  void drainDurableSceneBatch(projectId, task.id);
  return task;
}

export async function drainDurableSceneBatch(projectId: string, taskId: string): Promise<void> {
  await drainTask(projectId, taskId, {
    runEntry: async (entry, hooks): Promise<RunOutcome> => {
      // FR-6. Cheap, and it is what makes resuming a half-finished batch safe.
      const record = await getProjectRecord(projectId);
      if (sceneAlreadyProduced(record, entry.ref)) {
        logEvent("scene_queue.skipped_existing", { projectId, sceneId: entry.ref });
        return { kind: "completed" };
      }

      try {
        await generateSceneMedia(projectId, entry.ref, {
          onJobSubmitted: (jobId) => hooks.onSubmitted(jobId),
        });
        return { kind: "completed" };
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed";
        logEvent("scene_queue.failed", { projectId, sceneId: entry.ref, error: detail });
        return { kind: "failed", detail, retryable: false };
      }
    },

    /**
     * Ask the backend what happened, rather than assuming (FR-4).
     *
     * A completed job still needs its artifact checked: WanGP may have finished
     * the render while our process was down, in which case the files exist but
     * nothing wrote them into the record.
     */
    reconcileEntry: async (entry: TaskEntry) => {
      if (!entry.externalJobId) return "unknown";
      const record = await getProjectRecord(projectId);
      if (sceneAlreadyProduced(record, entry.ref)) return { kind: "completed" as const };

      const { status } = await resumeJob(entry.externalJobId);
      if (status === "completed") {
        // The backend finished it but we never recorded the output, so the
        // scene must be re-rendered — safe, because the job is over.
        return "unknown";
      }
      if (status === "failed" || status === "cancelled") {
        return { kind: "failed" as const, detail: `Backend job ${status}`, retryable: true };
      }
      // submitted / running / unknown: still out there, or unverifiable.
      return "unknown";
    },
  });
}

export async function cancelDurableSceneBatch(projectId: string): Promise<number> {
  const task = await activeSceneTask(projectId);
  if (!task) return 0;
  return requestCancel(projectId, task.id);
}
