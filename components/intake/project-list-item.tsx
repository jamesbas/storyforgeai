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

/**
 * A project in the sidebar list, with delete behind a two-step confirmation.
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
}: {
  project: Project;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [keepMedia, setKeepMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <Link
        href={`/storyboard/${project.id}`}
        className="block h-full rounded-md border border-white/10 bg-panel/40 px-3 py-2 pr-9 text-sm hover:border-accent"
      >
        <span className="block truncate font-medium">{project.title}</span>
        <span className="text-xs text-slate-500">
          {project.segmentCount} scenes · {project.status}
        </span>
        <span className="mt-0.5 block text-xs text-slate-600">
          Updated {relativeTime(project.updatedAt)}
        </span>
      </Link>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${project.title}`}
        title="Delete project"
        className="absolute right-1.5 top-1.5 rounded px-1.5 py-1 text-xs text-slate-600 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
      >
        ✕
      </button>
      {error ? <p className="mt-1 text-xs text-red-300">{error}</p> : null}
    </li>
  );
}
