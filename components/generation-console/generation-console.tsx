"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { WangpJob, WangpModel } from "@/lib/schemas/wangp";

type Status = { enabled: boolean; mode: string; url: string; ok: boolean };

export function GenerationConsole({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<WangpModel[]>([]);
  const [jobs, setJobs] = useState<WangpJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        fetch("/api/wangp/status").then((r) => r.json() as Promise<Status>),
        fetch("/api/wangp/models").then((r) => r.json() as Promise<{ models: WangpModel[] }>),
      ]);
      setStatus(s);
      setModels(m.models);
    } catch {
      setError("Failed to reach WanGP");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wangp/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { model_type: models[0]?.modelType ?? "wan_i2v_14b" } }),
      });
      if (!res.ok) throw new Error("Failed to submit job");
      const data = (await res.json()) as { job: WangpJob };
      setJobs((prev) => [data.job, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [models]);

  const poll = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/wangp/jobs/${jobId}`);
    if (res.ok) {
      const data = (await res.json()) as { job: WangpJob };
      setJobs((prev) => prev.map((j) => (j.id === jobId ? data.job : j)));
    }
  }, []);

  const imageModels = models.filter((m) => m.metadata.mainOutput === "image");
  const videoModels = models.filter((m) => m.metadata.mainOutput === "video");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Generation console</h1>
          <p className="mt-1 text-sm text-slate-400">WanGP model discovery and job queue.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit test job"}
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

      <section
        data-testid="wangp-status"
        className="rounded-lg border border-white/10 bg-panel/40 p-4 text-sm"
      >
        {status ? (
          <div className="flex flex-wrap gap-4">
            <span>
              Connection:{" "}
              <span className={status.ok ? "text-green-300" : "text-red-300"}>
                {status.ok ? "online" : "offline"}
              </span>
            </span>
            <span>Mode: {status.mode}</span>
            <span className="text-slate-500">{status.url}</span>
          </div>
        ) : (
          <span className="text-slate-400">Checking…</span>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Image models
          </h2>
          <ul className="mt-2 space-y-1 text-sm" data-testid="image-model-list">
            {imageModels.map((m) => (
              <li key={m.modelType} data-testid="wangp-model">
                {m.name} <span className="text-xs text-slate-500">{m.modelType}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Video models
          </h2>
          <ul className="mt-2 space-y-1 text-sm" data-testid="video-model-list">
            {videoModels.map((m) => (
              <li key={m.modelType} data-testid="wangp-model">
                {m.name} <span className="text-xs text-slate-500">{m.modelType}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Jobs</h2>
        <ul className="mt-2 space-y-2">
          {jobs.length === 0 && <li className="text-sm text-slate-500">No jobs submitted.</li>}
          {jobs.map((job) => (
            <li
              key={job.id}
              data-testid="wangp-job"
              className="flex items-center justify-between rounded-md border border-white/10 bg-panel/40 px-3 py-2 text-sm"
            >
              <span className="truncate">
                <span className="text-slate-500">{job.id.slice(0, 8)}</span> · {job.status} ·{" "}
                {job.progress}%
              </span>
              <button
                onClick={() => poll(job.id)}
                className="rounded-md border border-white/10 px-2 py-1 text-xs hover:border-accent"
              >
                Refresh
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
