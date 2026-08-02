"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

export function AnimaticReview({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!isCurrent()) return;
      if (res.ok) setRecord((await res.json()) as ProjectRecord);
      else setError("Failed to load project");
    },
    [projectId],
  );

  useLoadEffect(load);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-animatic`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to generate animatic");
      }
      setRecord((await res.json()) as ProjectRecord);
      setApproved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const animatic = record?.animaticPlan;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Animatic review</h1>
          <p className="mt-1 text-sm text-slate-400">
            Approve pacing and story flow before expensive video generation.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={busy}
            className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Working…" : animatic ? "Regenerate animatic" : "Generate animatic"}
          </button>
          {animatic && (
            <>
              <button
                onClick={() => setApproved(true)}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                {approved ? "Approved ✓" : "Approve animatic"}
              </button>
              <a
                href={`/api/projects/${projectId}/export?format=animatic`}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                Export plan
              </a>
            </>
          )}
          <Link
            href={`/storyboard/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Storyboard
          </Link>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {!animatic ? (
        <p className="text-sm text-slate-400">
          No animatic yet. Generate a storyboard first, then build the animatic.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-400">
            {animatic.frames.length} frames · {animatic.totalDurationSeconds}s total
          </p>
          <ol className="space-y-3">
            {animatic.frames.map((f) => (
              <li
                key={f.sceneNumber}
                data-testid="animatic-frame"
                className="rounded-lg border border-white/10 bg-panel/40 p-4"
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold">Frame {f.sceneNumber}</h3>
                  <span className="text-xs text-slate-500">
                    {f.durationSeconds}s · {f.transitionIn} → {f.transitionOut}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-300">{f.caption}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
