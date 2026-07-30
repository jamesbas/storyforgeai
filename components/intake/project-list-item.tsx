"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/schemas/project";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "3 hours ago" tells you which project you were on; an ISO timestamp does not. */
function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) return format.format(-Math.round(elapsed / ms), unit);
  }
  return "just now";
}

/** Outline trash can — the conventional affordance for a destructive action. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * A project in the list, with rename, copy and delete.
 *
 * Deletion is irreversible and the rendered clips represent real GPU hours, so
 * the confirmation names the project and states exactly what is about to go.
 * Keeping the media is offered rather than assumed: once the record is gone the
 * folder is unreachable from the UI, so silently leaving it behind would be
 * disk use nobody asked for.
 */
export function ProjectListItem({
  project,
  onDeleted,
  onChanged,
}: {
  project: Project;
  onDeleted: () => void;
  /** A rename or copy landed; the caller refreshes its list. */
  onChanged?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [keepMedia, setKeepMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(project.title);

  const rename = async () => {
    const next = title.trim();
    if (!next || next === project.title) {
      setRenaming(false);
      setTitle(project.title);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error(`Failed to rename (HTTP ${res.status})`);
      setRenaming(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename project");
      setTitle(project.title);
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/duplicate`, { method: "POST" });
      if (!res.ok) throw new Error(`Failed to copy (HTTP ${res.status})`);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to copy project");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${project.id}${keepMedia ? "?keepMedia=1" : ""}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to delete (HTTP ${res.status})`);
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <li className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
        <p className="text-sm font-medium">Delete &ldquo;{project.title}&rdquo;?</p>
        <p className="mt-1 text-xs text-slate-400">
          The storyboard, prompts, attempts and history are removed permanently. This cannot be
          undone.
        </p>

        <label className="mt-2 flex items-start gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={keepMedia}
            disabled={busy}
            onChange={(e) => setKeepMedia(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Keep generated images and video on disk
            <span className="block text-[11px] text-slate-500">
              They will no longer be reachable from the app.
            </span>
          </span>
        </label>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md bg-red-500/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative h-full">
      {renaming ? (
        <div className="h-full rounded-md border border-accent/60 bg-panel/40 px-3 py-2">
          <label htmlFor={`rename-${project.id}`} className="text-[11px] text-slate-400">
            Project name
          </label>
          <input
            id={`rename-${project.id}`}
            value={title}
            autoFocus
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") {
                setTitle(project.title);
                setRenaming(false);
              }
            }}
            className="mt-1 w-full rounded border border-white/10 bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void rename()}
              className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setTitle(project.title);
                setRenaming(false);
              }}
              className="rounded-md border border-white/15 px-3 py-1 text-xs text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <Link
            href={`/storyboard/${project.id}`}
            className="block h-full rounded-md border border-white/10 bg-panel/40 px-3 py-2 pr-24 text-sm hover:border-accent"
          >
            <span className="block truncate font-medium">{project.title}</span>
            <span className="text-xs text-slate-500">
              {project.segmentCount} scenes · {project.status}
            </span>
            <span className="mt-0.5 block text-xs text-slate-600">
              Updated {relativeTime(project.updatedAt)}
            </span>
          </Link>
          <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              disabled={busy}
              onClick={() => setRenaming(true)}
              aria-label={`Rename ${project.title}`}
              title="Rename project"
              className="rounded p-1.5 text-slate-500 hover:bg-white/10 hover:text-slate-200 disabled:opacity-50"
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void duplicate()}
              aria-label={`Copy ${project.title}`}
              title="Copy project (settings, plans and storyboard; not generated media)"
              className="rounded p-1.5 text-slate-500 hover:bg-white/10 hover:text-slate-200 disabled:opacity-50"
            >
              <CopyIcon />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${project.title}`}
              title="Delete project"
              className="rounded p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
            >
              <TrashIcon />
            </button>
          </div>
        </>
      )}
      {error ? <p className="mt-1 text-xs text-red-300">{error}</p> : null}
    </li>
  );
}
