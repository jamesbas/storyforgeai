"use client";

import { useState } from "react";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { normaliseNegative } from "@/lib/agents/negative-prompt";
import { sheetIsStale } from "@/lib/agents/cast-sheet";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";

/**
 * Offers to repair prompts that were written before the rules changed.
 *
 * Two mechanical fixes: negative prompts written as prose, and appended cast
 * text that no longer matches the scene — someone described who is not in the
 * shot, or a costume change set after the prompts were written. Both are
 * rebuilt from stored data with no model involved. Shown only when there is
 * something to fix.
 */
export function NegativePromptRepair({
  record,
  projectId,
  cast,
  onRepaired,
}: {
  record: ProjectRecord;
  projectId: string;
  cast: readonly Character[];
  onRepaired: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scenes = record.storyboard?.scenes ?? [];

  const staleNegatives = scenes.filter(
    (scene) =>
      normaliseNegative(scene.prompts.imageNegativePrompt) !== scene.prompts.imageNegativePrompt ||
      normaliseNegative(scene.prompts.videoNegativePrompt) !== scene.prompts.videoNegativePrompt,
  ).length;

  // The same comparison the repair itself makes, so the offer cannot disagree
  // with what pressing the button would do.
  const timeline = wardrobeTimeline(record.project, scenes, cast);
  const staleCast = scenes.filter((scene) =>
    sheetIsStale(scene, cast, timeline.get(scene.id)),
  ).length;

  if (staleNegatives === 0 && staleCast === 0) return null;

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
      <h2 className="text-sm font-semibold">Prompts written under older rules</h2>
      {staleCast ? (
        <p className="mt-1 text-sm text-slate-300">
          {staleCast} {staleCast === 1 ? "scene has" : "scenes have"} an appended character
          description that no longer matches the scene &mdash; someone described who is not in the
          shot, or a costume change set after the prompts were written. The description is the last
          thing the image model reads, so a wardrobe left behind there renders the old clothes.
          Rebuilding uses the characters each scene names and the wardrobe as it stands.
        </p>
      ) : null}
      {staleNegatives ? (
        <p className="mt-1 text-sm text-slate-300">
          {staleNegatives} {staleNegatives === 1 ? "scene has" : "scenes have"} a negative prompt
          phrased like <code>no watermarks, no distorted anatomy</code>. A sampler reads a negative
          prompt as a list of things to steer away from and has no operator for &ldquo;no&rdquo;.
          Rendering already strips it; this makes the stored prompt match.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-slate-500">
        Mechanical: no model runs, and nothing the agent wrote is reworded.
      </p>
      <button
        type="button"
        onClick={repair}
        disabled={busy}
        className="mt-3 rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold hover:border-accent disabled:opacity-50"
      >
        {busy ? "Repairing…" : "Repair prompts"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </section>
  );
}
