"use client";

import { useState } from "react";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { wardrobeContradictions } from "@/lib/agents/wardrobe";
import { isExplicitProject } from "@/lib/agents/explicitness";

/**
 * Scenes whose action reads as undressed while the wardrobe still says clothed.
 *
 * The stated outfit is appended last, which is the strongest position in the
 * prompt, so a sex scene carrying a robe on the cast sheet renders the robe.
 * Which scenes those are is a judgement, so this reports and offers rather than
 * deciding on its own.
 */
export function WardrobeCheck({
  record,
  projectId,
  cast,
  onApplied,
}: {
  record: ProjectRecord;
  projectId: string;
  cast: readonly Character[];
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scenes = record.storyboard?.scenes ?? [];
  const flagged =
    isExplicitProject(record.project) && cast.length
      ? wardrobeContradictions(record.project, scenes, cast)
      : [];

  if (flagged.length === 0) return null;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/undressed-scenes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneIds: flagged.map((f) => f.sceneId) }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to set wardrobe (HTTP ${res.status})`);
      }
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set wardrobe");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
      data-testid="wardrobe-check"
    >
      <h2 className="text-sm font-semibold">
        {flagged.length} {flagged.length === 1 ? "scene reads" : "scenes read"} as undressed but
        still carry an outfit
      </h2>
      <p className="mt-1 text-sm text-slate-300">
        The wardrobe is appended last and is the strongest single instruction in the prompt, so
        these will render with the clothes on. Setting them to nude applies from each scene onward
        and can be edited or undone per scene afterwards.
      </p>
      <ul className="mt-2 space-y-1 text-xs text-slate-400">
        {flagged.map((f) => (
          <li key={f.sceneId}>
            <span className="text-slate-300">Scene {f.sceneNumber}</span> — {f.title}
            <span className="text-slate-500"> · {f.characters.join(", ")}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={apply}
        disabled={busy}
        className="mt-3 rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold hover:border-accent disabled:opacity-50"
      >
        {busy ? "Setting…" : `Set nude for ${flagged.length === 1 ? "this scene" : "these scenes"}`}
      </button>
      <p className="mt-2 text-[11px] text-slate-500">
        Then use <strong>Repair prompts</strong> to fold it into the stored prompts without
        regenerating.
      </p>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </section>
  );
}
