"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { MediaDescriptor } from "@/lib/media/refs";
import { AudioCuePanel } from "@/components/assembly/audio-cue-panel";

type ExportDescriptor = { name: string; url: string; available: boolean };

export function AssemblyView({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [exportsList, setExportsList] = useState<ExportDescriptor[]>([]);
  const [media, setMedia] = useState<MediaDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepy, setDeepy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [rec, exp, med] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then((r) => (r.ok ? (r.json() as Promise<ProjectRecord>) : null)),
      fetch(`/api/projects/${projectId}/exports`).then((r) =>
        r.ok ? (r.json() as Promise<{ exports: ExportDescriptor[] }>) : { exports: [] },
      ),
      fetch(`/api/projects/${projectId}/media`).then((r) =>
        r.ok ? (r.json() as Promise<{ media: MediaDescriptor[] }>) : { media: [] },
      ),
    ]);
    if (rec) setRecord(rec);
    setExportsList(exp.exports);
    setMedia(med.media);
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
  const cut = media.find((m) => m.role === "final_cut" && m.available)
    ?? media.find((m) => m.role === "rough_cut" && m.available);

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

          {cut ? (
            <div className="mt-3 space-y-1" data-testid="cut-player">
              <video
                src={cut.url}
                controls
                preload="metadata"
                className="w-full rounded-md border border-white/10 bg-black"
              />
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{cut.label}</span>
                <a href={cut.downloadUrl} className="hover:text-accent">
                  Download
                </a>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              No playable file on disk. Set FFMPEG_ENABLED=true to render a real cut.
            </p>
          )}

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
          Music &amp; SFX cues
        </h2>
        <p className="mb-3 mt-1 text-xs text-slate-500">
          Dialogue is performed by the video model from each scene prompt. These cues are generated
          separately and mixed over the cut.
        </p>
        <AudioCuePanel
          projectId={projectId}
          cues={record?.audioPlan?.cues ?? []}
          scenes={(record?.storyboard?.scenes ?? []).map((s) => ({
            id: s.id,
            sceneNumber: s.sceneNumber,
            durationSeconds: s.trimAtEndSeconds ?? s.targetDurationSeconds,
          }))}
          media={media}
          onChanged={load}
        />
      </section>

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
