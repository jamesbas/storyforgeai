"use client";

import { useCallback, useState } from "react";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import { AsyncStatus } from "@/components/shared/async-status";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  isTerminal,
  needsOperator,
  type Task,
  type TaskEntry,
  type TaskFile,
} from "@/lib/schemas/tasks";

/**
 * Recovery panel for durable tasks (SPEC-008 §7).
 *
 * The wording here is load-bearing. A GPU job that the backend may still be
 * running is never called "cancelled" — the app cannot stop it, and saying
 * otherwise would send someone off to look for a render that is still burning
 * minutes.
 */

const STATE_LABELS: Record<TaskEntry["state"], string> = {
  pending: "Queued",
  submitting: "Submitting",
  submitted: "Submitted",
  running: "Running",
  reconciling: "Checking backend",
  completed: "Done",
  failed: "Failed",
  retry_pending: "Retrying",
  cancelled: "Cancelled",
  cancel_requested: "Stopping after this step",
  interrupted: "Interrupted",
  submission_unknown: "Unknown — may be running",
  stop_tracking: "No longer tracked",
};

function elapsed(entry: TaskEntry): string | null {
  if (!entry.startedAt) return null;
  const end = entry.finishedAt ? Date.parse(entry.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(entry.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The sentence the operator actually needs after a restart. */
function recoveryMessage(task: Task): string | null {
  const unknown = task.entries.filter((e) => e.state === "submission_unknown");
  const interrupted = task.entries.filter((e) => e.state === "interrupted");
  if (!unknown.length && !interrupted.length) return null;

  const names = [...unknown, ...interrupted].map((e) => e.label).join(", ");
  if (unknown.length) {
    return (
      `This run was interrupted while ${names} ${unknown.length > 1 ? "were" : "was"} being ` +
      "submitted. The backend may or may not have accepted it, so nothing was resent. " +
      "Check the backend, then resume or retry."
    );
  }
  return `This run was interrupted while ${names} was in flight. Resume to check the backend, or retry.`;
}

export function TaskRecoveryPanel({ projectId }: { projectId: string }) {
  const [file, setFile] = useState<TaskFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Task | null>(null);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      const res = await fetch(`/api/projects/${projectId}/tasks`, { cache: "no-store" });
      if (!res.ok || !isCurrent()) return;
      const next = (await res.json()) as TaskFile;
      if (isCurrent()) setFile(next);
    },
    [projectId],
  );

  useLoadEffect(load);

  const act = async (action: string, taskId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, taskId }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Action failed (HTTP ${res.status})`);
      }
      setFile((await res.json()) as TaskFile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const tasks = file?.tasks ?? [];
  if (!tasks.length) return null;

  const unresolved = tasks.filter((t) => !isTerminal(t.state) || needsOperator(t.state));
  const finished = tasks.length - unresolved.length;

  return (
    <section
      data-testid="task-recovery"
      aria-labelledby="task-recovery-heading"
      className="mt-4 rounded-md border border-white/10 bg-panel/40 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="task-recovery-heading" className="text-sm font-semibold">
          Background work
        </h2>
        {finished > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("dismiss")}
            className="min-h-[2.25rem] rounded-md border border-white/15 px-3 py-1 text-xs text-slate-200 hover:border-accent disabled:opacity-50"
          >
            Dismiss {finished} completed
          </button>
        ) : null}
      </div>

      <AsyncStatus message={error} failed={Boolean(error)} className="mt-2" />

      <ul className="mt-3 space-y-3">
        {tasks.map((task) => {
          const message = recoveryMessage(task);
          const stoppable = !isTerminal(task.state);
          const retryable = task.entries.some(
            (e) => e.state === "failed" || needsOperator(e.state) || e.state === "stop_tracking",
          );

          return (
            <li key={task.id} className="rounded border border-white/10 p-2">
              <p className="text-xs text-slate-300">
                {task.kind === "scene_batch" ? "Media generation" : "Plan run"} ·{" "}
                {STATE_LABELS[task.state]}
              </p>

              {message ? (
                <p data-testid="recovery-message" role="status" className="mt-1 text-xs text-amber-200">
                  {message}
                </p>
              ) : null}

              <ul className="mt-2 space-y-1">
                {task.entries.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid="task-entry"
                    className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-slate-400"
                  >
                    <span className="text-slate-200">{entry.label}</span>
                    <span>{STATE_LABELS[entry.state]}</span>
                    {elapsed(entry) ? <span>{elapsed(entry)}</span> : null}
                    {entry.attempts > 1 ? <span>attempt {entry.attempts}</span> : null}
                    {entry.error ? <span className="text-red-300">{entry.error}</span> : null}
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex flex-wrap gap-2">
                {task.entries.some((e) => e.state === "reconciling" || needsOperator(e.state)) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("resume", task.id)}
                    className="min-h-[2.25rem] rounded-md bg-accent-solid px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Resume
                  </button>
                ) : null}
                {retryable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("retry", task.id)}
                    className="min-h-[2.25rem] rounded-md border border-white/15 px-3 py-1 text-xs text-slate-200 hover:border-accent disabled:opacity-50"
                  >
                    Retry failed
                  </button>
                ) : null}
                {stoppable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("cancel", task.id)}
                    className="min-h-[2.25rem] rounded-md border border-white/15 px-3 py-1 text-xs text-slate-200 hover:border-accent disabled:opacity-50"
                  >
                    Cancel remaining
                  </button>
                ) : null}
                {task.entries.some((e) => needsOperator(e.state)) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(task)}
                    className="min-h-[2.25rem] rounded-md border border-white/15 px-3 py-1 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
                  >
                    Stop tracking
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={Boolean(confirming)}
        title="Stop tracking this run?"
        confirmLabel="Stop tracking"
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const id = confirming?.id;
          setConfirming(null);
          if (id) void act("stop_tracking", id);
        }}
      >
        <p>
          This only stops StoryForgeAI watching the job. If the backend accepted it, it may still
          be rendering and will still be using the GPU.
        </p>
        <p>Check WanGP directly if you need it stopped for real.</p>
      </ConfirmDialog>
    </section>
  );
}
