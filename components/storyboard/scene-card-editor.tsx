"use client";

import { useState } from "react";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

/** The story content a person may correct. Timing and identity are derived. */
const FIELDS = [
  { key: "title", label: "Title", rows: 1 },
  { key: "sceneObjective", label: "Objective", rows: 2 },
  { key: "storyBeat", label: "Story beat", rows: 2 },
  { key: "visualDescription", label: "Visual", rows: 3 },
  { key: "actionDescription", label: "Action", rows: 3 },
  { key: "cameraMovement", label: "Camera", rows: 1 },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Draft = Record<FieldKey, string>;

function draftFrom(scene: Scene): Draft {
  return {
    title: scene.title,
    sceneObjective: scene.sceneObjective,
    storyBeat: scene.storyBeat,
    visualDescription: scene.visualDescription,
    actionDescription: scene.actionDescription,
    cameraMovement: scene.cameraMovement,
  };
}

/**
 * The scene card, editable in place.
 *
 * Every prompt for this scene is written from this text, so a card describing
 * the wrong shot cannot be corrected downstream — a prompt agent given "the
 * men's hands are seen" writes a shot of hands however often it is asked. The
 * prompts were editable long before the card was, which had it backwards.
 */
export function SceneCardEditor({
  scene,
  projectId,
  busy = false,
  onSaved,
}: {
  scene: Scene;
  projectId: string;
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(scene));
  const [saving, setSaving] = useState<null | "card" | "prompts">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const original = draftFrom(scene);
  const dirty = FIELDS.some((f) => draft[f.key] !== original[f.key]);

  const save = async (thenRewrite: boolean) => {
    setSaving(thenRewrite ? "prompts" : "card");
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/card`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to save the card (HTTP ${res.status})`);
      }
      let record = (await res.json()) as ProjectRecord;

      if (thenRewrite) {
        const rewrite = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
          method: "POST",
        });
        if (!rewrite.ok) {
          const detail = (await rewrite.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Card saved, but rewriting prompts failed`);
        }
        record = (await rewrite.json()) as ProjectRecord;
      }

      setDone(thenRewrite ? "Card saved and prompts rewritten." : "Card saved.");
      onSaved?.(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the card");
    } finally {
      setSaving(null);
    }
  };

  const disabled = busy || saving !== null;

  return (
    <details className="mt-3 text-sm" data-testid="scene-card-editor">
      <summary className="cursor-pointer text-slate-300">
        Scene card
        <span className="ml-2 text-[11px] text-slate-500">
          what the prompts are written from · editable
          {dirty ? " · unsaved changes" : ""}
        </span>
      </summary>

      <p className="mt-2 text-xs text-slate-500">
        Prompts are written from this text, so correcting the card is how you change what the shot
        contains. Rewriting a scene&apos;s prompts without changing the card produces the same shot
        again.
      </p>

      <div className="mt-2 space-y-3">
        {FIELDS.map((field) => (
          <label key={field.key} className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{field.label}</span>
            <textarea
              rows={field.rows}
              disabled={disabled}
              value={draft[field.key]}
              onChange={(e) => {
                setDone(null);
                setDraft((current) => ({ ...current, [field.key]: e.target.value }));
              }}
              className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving === "prompts" ? "Saving and rewriting…" : "Save and rewrite prompts"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save(false)}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            {saving === "card" ? "Saving…" : "Save card only"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => {
              setDone(null);
              setDraft(draftFrom(scene));
            }}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            Revert
          </button>
          {done ? <span className="text-xs text-emerald-400">{done}</span> : null}
          {error ? <span className="text-xs text-red-300">{error}</span> : null}
        </div>

        <p className="text-[10px] text-slate-600">
          Saving the card alone leaves the existing prompts in place, so they will still describe the
          old shot until they are rewritten. Regenerating the whole storyboard replaces this card.
        </p>
      </div>
    </details>
  );
}
