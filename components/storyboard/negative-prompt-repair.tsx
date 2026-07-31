"use client";

import { useState } from "react";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { normaliseNegative } from "@/lib/agents/negative-prompt";

/**
 * Offers to rewrite stored negative prompts that were written as prose.
 *
 * Shown only when there is something to fix, so it disappears for good once
 * used. The render path already normalises these on the way out, so this
 * changes no output — it makes the prompt panel agree with what is sent.
 */
export function NegativePromptRepair({
  record,
  projectId,
  onRepaired,
}: {
  record: ProjectRecord;
  projectId: string;
  onRepaired: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stale = (record.storyboard?.scenes ?? []).filter(
    (scene) =>
      normaliseNegative(scene.prompts.imageNegativePrompt) !== scene.prompts.imageNegativePrompt ||
      normaliseNegative(scene.prompts.videoNegativePrompt) !== scene.prompts.videoNegativePrompt,
  ).length;

  if (stale === 0) return null;

  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/repair-prompts`, { method: "POST" });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Repair failed (HTTP ${res.status})`);
      }
      onRepaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Repair failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <h2 className="text-sm font-semibold">Negative prompts written as prose</h2>
      <p className="mt-1 text-sm text-slate-300">
        {stale} {stale === 1 ? "scene has" : "scenes have"} a negative prompt phrased like{" "}
        <code>no watermarks, no distorted anatomy</code>. A sampler reads a negative prompt as a
        list of things to steer away from and has no operator for &ldquo;no&rdquo;, so the negation
        contributes nothing. Rendering already strips it; this makes the stored prompt match.
      </p>
      <button
        type="button"
        onClick={repair}
        disabled={busy}
        className="mt-3 rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold hover:border-accent disabled:opacity-50"
      >
        {busy ? "Repairing…" : "Rewrite as term lists"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </section>
  );
}
