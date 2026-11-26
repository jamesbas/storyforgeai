"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AsyncStatus } from "@/components/shared/async-status";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import { ItemForm, type ItemPayload } from "@/components/scheduler/item-form";
import {
  ITEM_STATE_LABELS,
  formatDuration,
  itemTitle,
  optionsText,
  projectHref,
  scopeText,
  secondsBetween,
  type ProjectOption,
} from "@/components/scheduler/scheduler-rules";
import { phaseLabel } from "@/components/storyboard/phase-labels";
import { CASCADE_NOTICE, followOnNotice } from "@/components/storyboard/rerun-notices";
import {
  REQUEUEABLE_ITEM_STATES,
  isFinishedItem,
  type ItemState,
  type ScheduleItem,
} from "@/lib/schemas/schedule";
import type { SchedulerSnapshot } from "@/lib/services/scheduler-service";

const POLL_MS = 5000;

const STATE_LABELS: Record<SchedulerSnapshot["schedule"]["state"], string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
};

const CHIP_TONES: Partial<Record<ItemState, string>> = {
  running: "bg-accent/20 text-white",
  completed: "bg-emerald-500/15 text-emerald-200",
  completed_with_errors: "bg-amber-500/15 text-amber-200",
  failed: "bg-red-500/15 text-red-200",
  invalid: "bg-red-500/15 text-red-200",
  interrupted: "bg-amber-500/15 text-amber-200",
};

const PREPARING_TEXT = {
  restarting_wangp: "Restarting WanGP to free GPU memory…",
  loading_planning_model: "Loading the planning model…",
} as const;

function StateChip({ state }: { state: ItemState }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${CHIP_TONES[state] ?? "bg-white/10 text-slate-300"}`}>
      {ITEM_STATE_LABELS[state]}
    </span>
  );
}

const time = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

/** The run's progress, from the queue snapshot behind it. */
function progressText(current: NonNullable<SchedulerSnapshot["current"]>): string | null {
  const progress = current.progress;
  if (!progress) return null;
  if (progress.kind === "agents") {
    const step = progress.progress
      ? ` — ${progress.progress.phase}${
          progress.progress.total ? ` ${progress.progress.done ?? 0}/${progress.progress.total}` : ""
        }`
      : "";
    const agent = progress.agentName ? `${progress.agentName}${step}. ` : "";
    return `${agent}${progress.done} of ${progress.total} agents done.`;
  }
  const failed = progress.failed ? `, ${progress.failed} failed` : "";
  const phase = progress.phase
    ? ` ${phaseLabel(progress.phase.phase, current.runType === "video")}: ${progress.phase.completed} of ${progress.phase.total}.`
    : "";
  return `${progress.done} of ${progress.total} scenes done${failed}.${phase}`;
}

function statusMessage(snapshot: SchedulerSnapshot): string {
  const { schedule, current, waitingFor } = snapshot;
  switch (schedule.state) {
    case "idle":
      return "Idle. Add items, then press Start.";
    case "completed":
      return "Completed. Every queued item has run.";
    case "paused":
      return current
        ? `Pausing. ${current.label} finishes first, then nothing further starts.`
        : "Paused. Press Resume to carry on with the next queued item.";
    case "running":
      if (current) return `Running item ${current.position} of ${current.total}: ${current.label}.`;
      if (waitingFor) return `Waiting for ${waitingFor} (started by hand) to finish.`;
      return "Running. Picking the next item.";
  }
}

export function SchedulerView() {
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const refresh = useCallback(async (isCurrent: () => boolean = () => true) => {
    const res = await fetch("/api/scheduler", { cache: "no-store" });
    if (!res.ok || !isCurrent()) return;
    setSnapshot((await res.json()) as SchedulerSnapshot);
    setClock(Date.now());
  }, []);

  const loadAll = useCallback(
    async (isCurrent: () => boolean) => {
      try {
        const res = await fetch("/api/scheduler/projects", { cache: "no-store" });
        if (res.ok && isCurrent()) setProjects(((await res.json()) as { projects: ProjectOption[] }).projects);
        await refresh(isCurrent);
      } catch {
        if (isCurrent()) setError("Could not load the schedule.");
      }
    },
    [refresh],
  );
  useLoadEffect(loadAll);

  // Polled only while this tab is open; nothing runs in the browser otherwise.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const send = useCallback(
    async (url: string, method: string, body: Record<string, unknown> = {}): Promise<boolean> => {
      if (!snapshot) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, revision: snapshot.schedule.revision }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          details?: { staleRevision?: boolean };
          snapshot?: SchedulerSnapshot;
        } & Partial<SchedulerSnapshot>;
        if (!res.ok) {
          setError(data.error ?? `Request failed (HTTP ${res.status})`);
          if (data.details?.staleRevision) await refresh();
          return false;
        }
        setSnapshot(data.snapshot ?? (data as SchedulerSnapshot));
        setClock(Date.now());
        return true;
      } catch {
        setError("Could not reach StoryForge.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [snapshot, refresh],
  );

  const action = (name: string) => send("/api/scheduler", "POST", { action: name });
  const itemAction = (id: string, name: string) => send(`/api/scheduler/items/${id}`, "POST", { action: name });

  const items = useMemo(() => snapshot?.schedule.items ?? [], [snapshot]);
  const waiting = items.filter((item) => !isFinishedItem(item.state));
  const finished = items.filter((item) => isFinishedItem(item.state));
  const hasInvalid = items.some((item) => item.state === "invalid");
  const hasQueued = items.some((item) => item.state === "queued");

  if (!snapshot) {
    return <p className="text-sm text-slate-400">{error ?? "Loading the schedule…"}</p>;
  }

  const { schedule, current } = snapshot;
  const blocked = hasInvalid
    ? "Fix the invalid items before starting."
    : !hasQueued
      ? "Add an item to the queue first."
      : null;
  const elapsed = (iso: string) => formatDuration((clock - Date.parse(iso)) / 1000);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Scheduler</h1>
        <p className="mt-1 text-sm text-slate-400">
          Line up storyboard, keyframe and video runs across projects. They run one at a time, back to back,
          so the GPU is not idle while you sleep.
        </p>
      </header>

      {/* Status panel */}
      <section aria-labelledby="scheduler-status" className="space-y-3 rounded-lg border border-white/10 bg-panel/30 p-5">
        <h2 id="scheduler-status" className="font-semibold">
          Status: {STATE_LABELS[schedule.state]}
        </h2>
        <AsyncStatus message={statusMessage(snapshot)} busy={schedule.state === "running"} testId="scheduler-status" />

        {schedule.restartNotice && (
          <div role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            StoryForge restarted while <strong>{schedule.restartNotice.label}</strong> was running. Nothing has
            been restarted. Requeue it to finish the remaining scenes, then Resume.
          </div>
        )}

        {current && (
          <div className="space-y-1 text-sm" data-testid="scheduler-current">
            <p>
              <Link href={projectHref(current)} className="font-medium underline underline-offset-2 hover:text-accent">
                {current.label}
              </Link>{" "}
              <span className="text-slate-400">· {elapsed(current.startedAt)} elapsed</span>
            </p>
            {current.phase === "restarting_wangp" || current.phase === "loading_planning_model" ? (
              <p className="text-slate-300">
                {PREPARING_TEXT[current.phase]} ({elapsed(current.phaseStartedAt)})
              </p>
            ) : (
              progressText(current) && <p className="text-slate-300">{progressText(current)}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(schedule.state === "idle" || schedule.state === "completed") && (
            <button
              type="button"
              disabled={busy || Boolean(blocked)}
              onClick={() => void action("start")}
              className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80 disabled:opacity-50"
            >
              Start
            </button>
          )}
          {schedule.state === "paused" && (
            <button
              type="button"
              disabled={busy || Boolean(blocked)}
              onClick={() => void action("resume")}
              className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80 disabled:opacity-50"
            >
              Resume
            </button>
          )}
          {schedule.state === "running" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void action("pause")}
              className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
            >
              Pause
            </button>
          )}
          {current && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void action("cancelCurrent")}
              aria-describedby="scheduler-cancel-help"
              className="rounded-md border border-red-500/40 px-4 py-2 text-sm text-red-200 hover:border-red-400 disabled:opacity-50"
            >
              Cancel current item
            </button>
          )}
          {finished.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void action("clearFinished")}
              className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
            >
              Clear finished
            </button>
          )}
        </div>
        {current && (
          <p id="scheduler-cancel-help" className="text-xs text-slate-500">
            Cancelling abandons the scenes or agents that have not started. The one already in progress still
            finishes.
          </p>
        )}
        {blocked && schedule.state !== "running" && <p className="text-xs text-slate-500">{blocked}</p>}
        {schedule.state === "running" && (
          <p className="text-xs text-slate-400">
            You can close this browser tab. Keep StoryForge running and the PC awake until the batch finishes.
          </p>
        )}
        {schedule.state !== "running" && snapshot.busy && (
          <p className="text-xs text-slate-400">
            {snapshot.busy} is using the GPU. Start now and the first item waits for it to finish.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </section>

      {/* Add form */}
      <section aria-labelledby="scheduler-add" className="space-y-3 rounded-lg border border-white/10 bg-panel/20 p-5">
        <h2 id="scheduler-add" className="font-semibold">
          Add an item
        </h2>
        {projects.length === 0 ? (
          <p className="text-sm text-slate-400">No projects yet.</p>
        ) : (
          <ItemForm
            projects={projects}
            earlier={items}
            durableTasks={snapshot.durableTasks}
            busy={busy}
            onSubmit={(payload: ItemPayload) => send("/api/scheduler/items", "POST", payload)}
          />
        )}
      </section>

      {/* Queue */}
      <section aria-labelledby="scheduler-queue" className="space-y-3">
        <h2 id="scheduler-queue" className="font-semibold">
          Queue
        </h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing queued.</p>
        ) : (
          <ol className="space-y-2">
            {waiting.map((item, index) => {
              const number = index + 1;
              const title = itemTitle(item);
              const name = `item ${number}: ${title}`;
              const previous = waiting[index - 1];
              const followsRender =
                item.runType === "storyboard" &&
                (previous?.runType === "keyframes" || previous?.runType === "video");
              const locked = item.state === "running";
              const options = optionsText(item);
              const scope = scopeText(item);
              return (
                <li key={item.id} className="rounded-md border border-white/10 bg-panel/20 p-3" data-testid="scheduler-row">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-slate-500">{number}.</span>
                    <Link href={projectHref(item)} className="font-medium hover:text-accent">
                      {title}
                    </Link>
                    {scope && <span className="text-slate-400">{scope}</span>}
                    {options && <span className="text-slate-400">· {options}</span>}
                    <StateChip state={item.state} />
                  </div>
                  {item.reason && <p className="mt-1 text-xs text-red-300">{item.reason}</p>}
                  {followsRender && (
                    <p className="mt-1 text-xs text-slate-400">
                      {snapshot.wangpRestartAvailable
                        ? "WanGP will be restarted first to free GPU memory."
                        : "Tip: put storyboard runs first. WanGP may still hold GPU memory after a render batch."}
                    </p>
                  )}
                  {!locked && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <button
                        type="button"
                        disabled={busy || index === 0 || waiting[index - 1]?.state === "running"}
                        onClick={() => void itemAction(item.id, "moveUp")}
                        aria-label={`Move up ${name}`}
                        className="rounded border border-white/10 px-2 py-1 hover:border-accent disabled:opacity-40"
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={busy || index === waiting.length - 1}
                        onClick={() => void itemAction(item.id, "moveDown")}
                        aria-label={`Move down ${name}`}
                        className="rounded border border-white/10 px-2 py-1 hover:border-accent disabled:opacity-40"
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void itemAction(item.id, "duplicate")}
                        aria-label={`Duplicate ${name}`}
                        className="rounded border border-white/10 px-2 py-1 hover:border-accent disabled:opacity-40"
                      >
                        Duplicate
                      </button>
                      {item.runType !== "storyboard" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditingId(editingId === item.id ? null : item.id)}
                          aria-expanded={editingId === item.id}
                          aria-label={`Edit ${name}`}
                          className="rounded border border-white/10 px-2 py-1 hover:border-accent disabled:opacity-40"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void send(`/api/scheduler/items/${item.id}`, "DELETE").then(
                            (ok) => ok && editingId === item.id && setEditingId(null),
                          )
                        }
                        aria-label={`Remove ${name}`}
                        className="rounded border border-red-500/30 px-2 py-1 text-red-200 hover:border-red-400 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  {editingId === item.id && !locked && (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      <ItemForm
                        key={item.id}
                        projects={projects}
                        earlier={items.slice(0, items.findIndex((candidate) => candidate.id === item.id))}
                        durableTasks={snapshot.durableTasks}
                        initial={item}
                        busy={busy}
                        onCancel={() => setEditingId(null)}
                        onSubmit={async (payload) => {
                          const ok = await send(`/api/scheduler/items/${item.id}`, "PATCH", {
                            scope: payload.scope,
                            options: payload.options,
                          });
                          if (ok) setEditingId(null);
                          return ok;
                        }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* History */}
      {finished.length > 0 && (
        <section aria-labelledby="scheduler-history" className="space-y-3">
          <h2 id="scheduler-history" className="font-semibold">
            Finished
          </h2>
          <ul className="space-y-2">
            {finished.map((item) => (
              <FinishedRow key={item.id} item={item} busy={busy} onRequeue={() => void itemAction(item.id, "requeue")} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FinishedRow({ item, busy, onRequeue }: { item: ScheduleItem; busy: boolean; onRequeue: () => void }) {
  const title = itemTitle(item);
  const duration = secondsBetween(item.startedAt, item.finishedAt);
  const summary = item.summary;
  const unit = item.runType === "storyboard" ? "agents" : "scenes";
  const notes = [
    ...(summary?.notes ?? []),
    ...(item.preparation?.warnings ?? []),
    ...(summary?.cascaded ? [CASCADE_NOTICE] : []),
    ...(summary?.followOn?.length ? [followOnNotice(summary.followOn)] : []),
    ...(summary?.droppedScenes?.length
      ? [`Scene${summary.droppedScenes.length === 1 ? "" : "s"} ${summary.droppedScenes.join(", ")} no longer existed and ${summary.droppedScenes.length === 1 ? "was" : "were"} left out.`]
      : []),
  ];
  return (
    <li className="rounded-md border border-white/10 bg-panel/10 p-3 text-sm" data-testid="scheduler-finished-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={projectHref(item)} className="font-medium hover:text-accent">
          {title}
        </Link>
        {scopeText(item) && <span className="text-slate-400">{scopeText(item)}</span>}
        <StateChip state={item.state} />
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {time(item.startedAt)} → {time(item.finishedAt)}
        {duration !== null && ` · ${formatDuration(duration)}`}
        {item.waitedSeconds ? ` · waited ${formatDuration(item.waitedSeconds)} for the GPU` : ""}
      </p>
      {summary && summary.total > 0 && (
        <p className="text-xs text-slate-400">
          {summary.completed} completed · {summary.failed} failed · {summary.skipped} skipped of {summary.total} {unit}
        </p>
      )}
      {item.reason && <p className="mt-1 text-xs text-red-300">{item.reason}</p>}
      {summary?.firstError && summary.firstError !== item.reason && (
        <p className="mt-1 text-xs text-red-300">First failure: {summary.firstError}</p>
      )}
      {notes.map((note) => (
        <p key={note} className="mt-1 text-xs text-slate-300">
          {note}
        </p>
      ))}
      {item.durableTaskId && item.state === "interrupted" && (
        <p className="mt-1 text-xs text-slate-300">
          This ran on a durable task.{" "}
          <Link href={`/storyboard/${item.projectId}`} className="underline underline-offset-2 hover:text-accent">
            Open the project&apos;s recovery controls
          </Link>
          .
        </p>
      )}
      {REQUEUEABLE_ITEM_STATES.includes(item.state) && (
        <button
          type="button"
          disabled={busy}
          onClick={onRequeue}
          aria-label={`Requeue ${title}`}
          className="mt-2 rounded border border-white/10 px-2 py-1 text-xs hover:border-accent disabled:opacity-40"
        >
          Requeue
        </button>
      )}
    </li>
  );
}
