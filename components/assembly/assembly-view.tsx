"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

type ExportDescriptor = { name: string; url: string; available: boolean };

export function AssemblyView({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [exportsList, setExportsList] = useState<ExportDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepy, setDeepy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [rec, exp] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then((r) => (r.ok ? (r.json() as Promise<ProjectRecord>) : null)),
      fetch(`/api/projects/${projectId}/exports`).then((r) =>
        r.ok ? (r.json() as Promise<{ exports: ExportDescriptor[] }>) : { exports: [] },
      ),
    ]);
    if (rec) setRecord(rec);
    setExportsList(exp.exports);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const assemble = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assemble`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to assemble");
      }
      setRecord((await res.json()) as ProjectRecord);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [projectId, load]);

  const askDeepy = useCallback(
    async (sceneId: string, target: string) => {
      const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/deepy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect_video_frame", target }),
      });
      if (res.ok) {
        const data = (await res.json()) as { result: string };
        setDeepy(data.result);
      }
    },
    [projectId],
  );

  const assembly = record?.assembly;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Assembly</h1>
          <p className="mt-1 text-sm text-slate-400">
            Combine approved clips into a rough cut and export the package.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={assemble}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Assembling…" : "Assemble rough cut"}
          </button>
          <Link
            href={`/storyboard/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Storyboard
          </Link>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {assembly ? (
        <section
          data-testid="assembly-result"
          className="rounded-lg border border-white/10 bg-panel/40 p-4"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Rough cut</h2>
          <p className="mt-1 text-sm" data-testid="rough-cut-path">
            {assembly.roughCutPath}
          </p>
          <p className="text-xs text-slate-500">
            {assembly.plan.clips.length} clips · {assembly.plan.totalDurationSeconds}s
          </p>
          <ol className="mt-3 space-y-2">
            {assembly.plan.clips.map((c) => (
              <li
                key={c.sceneId}
                className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2 text-sm"
              >
                <span className="truncate">
                  Scene {c.sceneNumber} · {c.durationSeconds}s ·{" "}
                  <span className="text-slate-500">{c.path}</span>
                </span>
                <button
                  onClick={() => askDeepy(c.sceneId, c.path)}
                  className="rounded-md border border-white/10 px-2 py-1 text-xs hover:border-accent"
                >
                  Ask Deepy
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <p className="text-sm text-slate-400">
          No rough cut yet. Approve scene media, then assemble.
        </p>
      )}

      {deepy && (
        <p data-testid="deepy-result" className="rounded-md bg-white/5 px-3 py-2 text-sm text-slate-300">
          {deepy}
        </p>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Export package
        </h2>
        <ul className="mt-2 space-y-2">
          {exportsList.map((e) => (
            <li key={e.name}>
              {e.available ? (
                <a
                  href={e.url}
                  className="text-sm text-accent hover:underline"
                  data-testid="export-link"
                >
                  {e.name}
                </a>
              ) : (
                <span className="text-sm text-slate-600">{e.name} (not available yet)</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
