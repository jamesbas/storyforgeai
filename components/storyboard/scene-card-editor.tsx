"use client";

import { useState } from "react";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { DialogueLine } from "@/lib/schemas/audio";

/** The story content a person may correct. Timing and identity are derived. */
const FIELDS = [
  { key: "title", label: "Title", rows: 1 },
  { key: "sceneObjective", label: "Objective", rows: 2 },
  { key: "storyBeat", label: "Story beat", rows: 2 },
  { key: "visualDescription", label: "Visual", rows: 3 },
  { key: "actionDescription", label: "Action", rows: 3 },
  { key: "cameraMovement", label: "Camera", rows: 1 },
  { key: "narrationText", label: "Voice-over (from outside the scene)", rows: 2 },
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
    narrationText: scene.narrationText ?? "",
  };
}

const linesFrom = (scene: Scene): DialogueLine[] =>
  (scene.dialogue ?? []).map((d) => ({ character: d.character, line: d.line }));

const sameLines = (a: DialogueLine[], b: DialogueLine[]) =>
  a.length === b.length && a.every((l, i) => l.character === b[i]!.character && l.line === b[i]!.line);

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
  const [synced, setSynced] = useState<Draft>(() => draftFrom(scene));
  const [lines, setLines] = useState<DialogueLine[]>(() => linesFrom(scene));
  const [syncedLines, setSyncedLines] = useState<DialogueLine[]>(() => linesFrom(scene));
  const [saving, setSaving] = useState<null | "card" | "prompts">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const stored = draftFrom(scene);
  const storedLines = linesFrom(scene);
  const dirty =
    FIELDS.some((f) => draft[f.key] !== synced[f.key]) || !sameLines(lines, syncedLines);

  // Regenerating the storyboard replaces this card while the panel may be open.
  // The draft is seeded once at mount, so without this it keeps showing the
  // card that was replaced. Unsaved edits are never discarded.
  if (FIELDS.some((f) => stored[f.key] !== synced[f.key]) || !sameLines(storedLines, syncedLines)) {
    setSynced(stored);
    setSyncedLines(storedLines);
    if (!dirty) {
      setDraft(stored);
      setLines(storedLines);
    }
  }

  const spokenWords = lines
    .flatMap((l) => l.line.trim().split(/\s+/))
    .filter(Boolean).length;

  const save = async (thenRewrite: boolean) => {
    setSaving(thenRewrite ? "prompts" : "card");
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/card`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...draft,
          dialogue: lines.filter((l) => l.character.trim() && l.line.trim()),
        }),
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

        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            Dialogue
            <span className="ml-2 normal-case tracking-normal text-slate-600">
              {spokenWords} words · about {Math.round(scene.targetDurationSeconds * 2)} fills{" "}
              {scene.targetDurationSeconds}s
            </span>
          </span>
          <p className="text-xs text-slate-500">
            Spoken aloud by the video model, word for word. This is the only source of speech in
            the clip.
          </p>
          {lines.map((line, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="text"
                value={line.character}
                disabled={disabled}
                placeholder="Who"
                aria-label={`Speaker ${index + 1}`}
                onChange={(e) => {
                  setDone(null);
                  setLines((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, character: e.target.value } : r)),
                  );
                }}
                className="w-1/4 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <textarea
                rows={2}
                value={line.line}
                disabled={disabled}
                placeholder="What they say"
                aria-label={`Line ${index + 1}`}
                onChange={(e) => {
                  setDone(null);
                  setLines((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, line: e.target.value } : r)),
                  );
                }}
                className="flex-1 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setDone(null);
                  setLines((rows) => rows.filter((_, i) => i !== index));
                }}
                className="rounded-md border border-white/10 px-2 text-xs text-slate-400 hover:border-red-500/50 hover:text-red-300"
                aria-label={`Remove line ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDone(null);
              setLines((rows) => [...rows, { character: "", line: "" }]);
            }}
            className="rounded-md border border-white/15 px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          >
            Add a line
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save(true)}
            className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
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
              setDraft(stored);
              setLines(storedLines);
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
