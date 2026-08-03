"use client";

import { useRef, useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";

type Outcome = {
  project: { id: string; title: string };
  source: "record" | "storyboard_export";
  missingPlans: string[];
  attempts: number;
  missingMedia: number;
};

/**
 * Restore a project from a file the app wrote.
 *
 * Always creates a new project rather than overwriting one, so importing the
 * same file twice costs a duplicate and never work. What a file could not
 * carry is reported rather than left to be discovered later: a storyboard
 * export has no canvas plans, and a project deleted with its media comes back
 * pointing at files that are gone.
 */
export function ImportProject({ onImported }: { onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const importStatus = busy
    ? "Importing the project file…"
    : outcome
      ? `Project restored. ${outcome.missingPlans.length} plans missing, ${outcome.missingMedia} media files missing.`
      : null;

  const pick = async (file: File) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await fetch("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await file.text(),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? "Could not import that file");
      }
      setOutcome((await res.json()) as Outcome);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import that file");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="rounded-md border border-white/15 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import a project file"}
      </button>
      <p className="text-xs text-slate-500">
        Restores from a <code>project.json</code> record, which carries everything, or a{" "}
        <code>storyboard.json</code> export, which carries the scenes and prompts but no creative
        plans. Import always creates a new project, so it can never overwrite one.
      </p>

      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}

      {/*
        Counts only. The project title below is user content and stays visible
        rather than announced.
      */}
      <AsyncStatus testId="import-status" message={importStatus} busy={busy} />

      {outcome && (
        <div
          data-testid="import-outcome"
          className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-200/90"
        >
          <p>
            Restored <strong>{outcome.project.title}</strong> from{" "}
            {outcome.source === "record" ? "a full project record" : "a storyboard export"}.
          </p>
          {outcome.missingPlans.length > 0 && (
            <p className="mt-1 text-amber-200/90">
              No plan came back for {outcome.missingPlans.join(", ")}. A storyboard export does not
              carry them, so run those agents and regenerate the storyboard before spending GPU time
              — otherwise the renders lose that direction without saying so.
            </p>
          )}
          {outcome.missingMedia > 0 && (
            <p className="mt-1 text-amber-200/90">
              {outcome.attempts} attempt{outcome.attempts === 1 ? "" : "s"} came back, but{" "}
              {outcome.missingMedia} of their files are no longer on disk — media is deleted with a
              project unless you kept it. The references are left in place in case you can restore
              the files; otherwise regenerate those scenes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
