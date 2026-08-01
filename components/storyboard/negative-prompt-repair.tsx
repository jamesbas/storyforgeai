"use client";

import { useState } from "react";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { normaliseNegative } from "@/lib/agents/negative-prompt";
import { charactersInScene } from "@/lib/agents/scene-cast";

/**
 * Offers to repair prompts that were written before the rules changed.
 *
 * Two mechanical fixes: negative prompts written as prose, and cast sheets
 * appended for characters who are not in the shot. Both are rebuilt from stored
 * data with no model involved. Shown only when there is something to fix.
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

  const staleCast = scenes.filter((scene) => {
    const present = new Set(charactersInScene(scene, cast).map((c) => c.id));
    return cast.some(
      (c) =>
        !present.has(c.id) &&
        (scene.prompts.startFramePrompt.includes(`${c.name}:`) ||
          scene.prompts.videoPromptSegment.includes(`${c.name}:`)),
    );
  }).length;

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
          {staleCast} {staleCast === 1 ? "scene describes a character" : "scenes describe characters"}{" "}
          who are not in the shot. The description was appended to every scene regardless of who
          appeared in it, which asks the image model to put them in the picture. Rebuilding uses the
          characters each scene actually names.
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
