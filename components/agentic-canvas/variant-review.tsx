"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";

/** What each direction changes, so three cards read as three choices. */
const VARIANT_AXIS: Readonly<Record<string, string>> = {
  concept: "different premise",
  story: "different story",
  visual_style: "different look",
  hook: "different opening",
  scene: "different moments",
  platform_cut: "different platform",
};

/** The chip names the axis; this says what the axis holds still. */
const VARIANT_CHANGES: Readonly<Record<string, string>> = {
  concept: "The premise and framing. Same subject, a different idea about it.",
  story: "The events and whose story it is. The look stays the same.",
  visual_style: "The look only. Same story, same opening.",
  hook: "The way in only. Same story, same look.",
  scene: "Which moments are shown. Same story, same look.",
  platform_cut: "Length and pacing for a different platform.",
};

export function VariantReview({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.ok) setRecord((await res.json()) as ProjectRecord);
    else setError("Failed to load project");
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-variants`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to generate variants");
      setRecord((await res.json()) as ProjectRecord);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const select = useCallback(
    async (variantId: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/variants/${variantId}/select`, {
          method: "POST",
        });
        if (!res.ok) throw new Error("Failed to select variant");
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const variants: CreativeVariant[] = record?.variants ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Variant review</h1>
          <p className="mt-1 text-sm text-slate-400">
            Explore creative directions before committing to a storyboard.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Working…" : variants.length ? "Regenerate variants" : "Generate variants"}
          </button>
          <Link
            href={`/storyboard/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Go to storyboard
          </Link>
          <Link
            href={`/agentic-canvas/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Agentic canvas
          </Link>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {variants.length === 0 ? (
        <p className="text-sm text-slate-400">No variants yet. Generate 3 creative directions.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {variants.map((v) => (
            <article
              key={v.id}
              data-testid="variant-card"
              className={`rounded-lg border p-4 ${
                v.selected ? "border-accent bg-accent/10" : "border-white/10 bg-panel/40"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{v.name}</h3>
                <span
                  className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400"
                  title="What this direction changes relative to the others"
                >
                  {VARIANT_AXIS[v.variantType] ?? v.variantType}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-300">{v.summary}</p>
              {VARIANT_CHANGES[v.variantType] ? (
                <p data-testid="variant-changes" className="mt-1 text-xs text-slate-500">
                  What changes: {VARIANT_CHANGES[v.variantType]}
                </p>
              ) : null}
              <dl className="mt-3 space-y-1 text-xs text-slate-400">
                {v.hook && <div>Hook: {v.hook}</div>}
                {v.bestFitPlatform && <div>Best fit: {v.bestFitPlatform}</div>}
                <div>Strengths: {v.strengths.join(", ")}</div>
                <div>Gives up: {v.risks.join(", ")}</div>
              </dl>
              <button
                onClick={() => select(v.id)}
                disabled={busy}
                className="mt-4 w-full rounded-md border border-white/10 px-3 py-2 text-sm hover:border-accent disabled:opacity-50"
              >
                {v.selected ? "Selected ✓" : "Select direction"}
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
