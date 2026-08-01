"use client";

import { useState } from "react";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { WardrobeChange } from "@/lib/schemas/wardrobe";

type Row = { key: string; subject: string; wardrobe: string; mode: "within" | "between" };

/**
 * Costume changes at this scene.
 *
 * Project wardrobe is repeated into every prompt so clothing does not drift
 * between two independently rendered frames. That makes it a constant, and a
 * story where someone gets dressed needs a way to say when it stops being one.
 * A change here applies from this scene onward.
 *
 * Unnamed people get the same treatment through a free-text subject: they have
 * no id to key on, and without one they stay locked in whatever they were first
 * rendered wearing.
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
  changes: readonly WardrobeChange[];
  continuousTake: boolean;
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [castDraft, setCastDraft] = useState<
    Record<string, { wardrobe: string; mode: "within" | "between" }>
  >(() =>
    Object.fromEntries(
      changes
        .filter((c) => c.characterId)
        .map((c) => [c.characterId!, { wardrobe: c.wardrobe, mode: c.mode }]),
    ),
  );
  const [others, setOthers] = useState<Row[]>(() =>
    changes
      .filter((c) => c.subject)
      .map((c, i) => ({
        key: `existing-${i}`,
        subject: c.subject!,
        wardrobe: c.wardrobe,
        mode: c.mode,
      })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const touched = () => {
    setSaved(false);
    setError(null);
  };

  const setCast = (
    id: string,
    patch: Partial<{ wardrobe: string; mode: "within" | "between" }>,
  ) => {
    touched();
    setCastDraft((d) => {
      const existing = d[id] ?? { wardrobe: "", mode: "between" as const };
      return { ...d, [id]: { ...existing, ...patch } };
    });
  };

  const setOther = (key: string, patch: Partial<Row>) => {
    touched();
    setOthers((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setWarning(null);
    setSaved(false);
    try {
      const payload: WardrobeChange[] = [
        ...Object.entries(castDraft)
          .filter(([, v]) => v.wardrobe.trim())
          .map(([characterId, v]) => ({
            characterId,
            wardrobe: v.wardrobe.trim(),
            mode: v.mode,
          })),
        ...others
          .filter((r) => r.subject.trim() && r.wardrobe.trim())
          .map((r) => ({ subject: r.subject.trim(), wardrobe: r.wardrobe.trim(), mode: r.mode })),
      ];
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

  const modeChoice = (
    name: string,
    mode: "within" | "between",
    onChange: (next: "within" | "between") => void,
  ) => (
    <div className="flex gap-3 text-xs text-slate-400">
      {(["between", "within"] as const).map((option) => (
        <label key={option} className="flex items-center gap-1.5">
          <input
            type="radio"
            name={name}
            checked={mode === option}
            onChange={() => onChange(option)}
            className="accent-accent"
          />
          <span>{option === "between" ? "Already changed" : "Changes on screen"}</span>
        </label>
      ))}
    </div>
  );

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

      {cast.length ? (
        <div className="mt-2 space-y-3">
          {cast.map((character) => {
            const entry = castDraft[character.id];
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
                  onChange={(e) => setCast(character.id, { wardrobe: e.target.value })}
                  className="w-full rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setCast(character.id, { wardrobe: "nude" })}
                  disabled={busy || saving}
                  className="text-[11px] text-slate-500 underline hover:text-accent disabled:opacity-50"
                >
                  Nude
                </button>
                {entry?.wardrobe.trim()
                  ? modeChoice(`wardrobe-mode-${scene.id}-${character.id}`, entry.mode, (next) =>
                      setCast(character.id, { mode: next }),
                    )
                  : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <p className="text-xs text-slate-400">
          Anyone not in the character library
          <span className="ml-1 text-slate-500">
            — describe them the way the prompt should, such as &ldquo;the two men&rdquo;. Their
            outfit carries forward from here too.
          </span>
        </p>
        {others.map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex gap-2">
              <input
                type="text"
                value={row.subject}
                disabled={busy || saving}
                placeholder="the two men"
                aria-label="Who"
                onChange={(e) => setOther(row.key, { subject: e.target.value })}
                className="w-1/3 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <input
                type="text"
                value={row.wardrobe}
                disabled={busy || saving}
                placeholder="bare-chested, in dark jeans"
                aria-label="What they wear from here"
                onChange={(e) => setOther(row.key, { wardrobe: e.target.value })}
                className="flex-1 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  touched();
                  setOthers((rows) => rows.filter((r) => r.key !== row.key));
                }}
                disabled={busy || saving}
                className="rounded-md border border-white/10 px-2 text-xs text-slate-400 hover:border-red-500/50 hover:text-red-300"
                aria-label={`Remove ${row.subject || "row"}`}
              >
                Remove
              </button>
            </div>
            {row.subject.trim() && row.wardrobe.trim()
              ? modeChoice(`wardrobe-mode-${scene.id}-${row.key}`, row.mode, (next) =>
                  setOther(row.key, { mode: next }),
                )
              : null}
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            touched();
            setOthers((rows) => [
              ...rows,
              { key: `row-${Date.now()}`, subject: "", wardrobe: "", mode: "between" },
            ]);
          }}
          disabled={busy || saving}
          className="rounded-md border border-white/15 px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
        >
          Add someone
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">
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
