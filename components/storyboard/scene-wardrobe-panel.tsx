"use client";

import { useState } from "react";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { WardrobeChange } from "@/lib/schemas/wardrobe";

/**
 * Costume changes at this scene.
 *
 * Project wardrobe is repeated into every prompt so clothing does not drift
 * between two independently rendered frames. That makes it a constant, and a
 * story where someone gets dressed needs a way to say when it stops being one.
 * A change here applies from this scene onward.
 */
export function SceneWardrobePanel({
  scene,
  projectId,
  cast,
  changes,
  continuousTake,
  busy = false,
  onSaved,
}: {
  scene: Scene;
  projectId: string;
  cast: readonly Character[];
  /** What each character wears entering this scene, for the "unchanged" hint. */
  changes: readonly WardrobeChange[];
  continuousTake: boolean;
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [draft, setDraft] = useState<Record<string, { wardrobe: string; mode: "within" | "between" }>>(
    () =>
      Object.fromEntries(
        changes.map((c) => [c.characterId, { wardrobe: c.wardrobe, mode: c.mode }]),
      ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (cast.length === 0) return null;

  const set = (id: string, patch: Partial<{ wardrobe: string; mode: "within" | "between" }>) => {
    setSaved(false);
    setDraft((d) => {
      const existing = d[id] ?? { wardrobe: "", mode: "between" as const };
      return { ...d, [id]: { ...existing, ...patch } };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setWarning(null);
    setSaved(false);
    try {
      const payload = Object.entries(draft)
        .filter(([, v]) => v.wardrobe.trim())
        .map(([characterId, v]) => ({
          characterId,
          wardrobe: v.wardrobe.trim(),
          mode: v.mode,
        }));
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/wardrobe`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: payload }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to save wardrobe (HTTP ${res.status})`);
      }
      const body = (await res.json()) as { record: ProjectRecord; warning: string | null };
      setWarning(body.warning);
      setSaved(true);
      onSaved?.(body.record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save wardrobe");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="mt-3 text-sm" data-testid="scene-wardrobe">
      <summary className="cursor-pointer text-slate-300">
        Wardrobe change
        {changes.length ? (
          <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200">
            {changes.length}
          </span>
        ) : null}
      </summary>

      <p className="mt-2 text-xs text-slate-500">
        Leave blank for no change. Anything set here applies from this scene onward, so you only
        need to say it once.
      </p>

      <div className="mt-2 space-y-3">
        {cast.map((character) => {
          const entry = draft[character.id];
          return (
            <div key={character.id} className="space-y-1">
              <label
                htmlFor={`wardrobe-${scene.id}-${character.id}`}
                className="text-xs text-slate-400"
              >
                {character.name}
              </label>
              <input
                id={`wardrobe-${scene.id}-${character.id}`}
                type="text"
                value={entry?.wardrobe ?? ""}
                disabled={busy || saving}
                placeholder="unchanged"
                onChange={(e) => set(character.id, { wardrobe: e.target.value })}
                className="w-full rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              {entry?.wardrobe.trim() ? (
                <div className="flex gap-3 text-xs text-slate-400">
                  {(["between", "within"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`wardrobe-mode-${scene.id}-${character.id}`}
                        checked={(entry.mode ?? "between") === mode}
                        onChange={() => set(character.id, { mode })}
                        className="accent-accent"
                      />
                      <span>
                        {mode === "between" ? "Already changed" : "Changes on screen"}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-slate-500">
        <strong>Already changed</strong> means both frames of this scene show the new outfit — no
        render has to depict a garment mid-transition, which is the safer choice.{" "}
        <strong>Changes on screen</strong> puts the old outfit in the start frame and the new one in
        the end frame, so the clip shows it happening.
        {continuousTake ? " This project is a continuous take, so there is no cut to hide it in." : ""}
      </p>

      <button
        type="button"
        onClick={save}
        disabled={busy || saving}
        className="mt-2 rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold hover:border-accent disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save wardrobe change"}
      </button>
      {saved ? (
        <p className="mt-2 text-xs text-emerald-300">
          Saved. It reaches the render when this scene&apos;s prompts are next written — regenerate
          the storyboard to apply it.
        </p>
      ) : null}
      {warning ? <p className="mt-2 text-xs text-amber-300">{warning}</p> : null}
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </details>
  );
}
