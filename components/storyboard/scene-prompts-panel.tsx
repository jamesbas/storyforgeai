"use client";

import { useState } from "react";
import type { Scene } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/** The prompt fields a user may edit. The quality checklist is agent review notes. */
const FIELDS = [
  { key: "startFramePrompt", label: "Start frame", rows: 4, kind: "image" },
  { key: "endFramePrompt", label: "End frame", rows: 4, kind: "image" },
  { key: "imageNegativePrompt", label: "Image negative", rows: 2, kind: "image" },
  { key: "videoPromptSegment", label: "Video (motion)", rows: 5, kind: "video" },
  { key: "videoNegativePrompt", label: "Video negative", rows: 2, kind: "video" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Draft = Record<FieldKey, string>;

function draftFrom(scene: Scene): Draft {
  return {
    startFramePrompt: scene.prompts.startFramePrompt,
    endFramePrompt: scene.prompts.endFramePrompt,
    imageNegativePrompt: scene.prompts.imageNegativePrompt,
    videoPromptSegment: scene.prompts.videoPromptSegment,
    videoNegativePrompt: scene.prompts.videoNegativePrompt,
  };
}

/**
 * The prompts actually sent to WanGP, editable in place.
 *
 * Agent-written prompts are a strong starting point rather than a final answer,
 * and regenerating the whole storyboard to fix one clumsy line loses every other
 * scene's wording. Editing here changes only this scene.
 */
export function ScenePromptsPanel({
  scene,
  projectId,
  triggerWords,
  busy = false,
  onSaved,
}: {
  scene: Scene;
  projectId: string;
  /** Trigger words that will be appended automatically, by prompt kind. */
  triggerWords?: { image: string[]; video: string[] };
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(scene));
  const [synced, setSynced] = useState<Draft>(() => draftFrom(scene));
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const stored = draftFrom(scene);
  const dirty = FIELDS.some((f) => draft[f.key] !== synced[f.key]);

  // These prompts can be rewritten while the panel is open — editing the scene
  // card offers to rewrite them, and so does regenerating the storyboard. The
  // draft is seeded once at mount, so without this it keeps showing the old
  // text until the page is reloaded. Unsaved edits are never discarded.
  if (FIELDS.some((f) => stored[f.key] !== synced[f.key])) {
    setSynced(stored);
    if (!dirty) setDraft(stored);
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to save prompts (HTTP ${res.status})`);
      }
      const record = (await res.json()) as ProjectRecord;
      onSaved?.(record);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompts");
    } finally {
      setSaving(false);
    }
  };

  const rewrite = async () => {
    setRewriting(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
        method: "POST",
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to rewrite prompts (HTTP ${res.status})`);
      }
      const record = (await res.json()) as ProjectRecord;
      const next = record.storyboard?.scenes.find((s) => s.id === scene.id);
      // An explicit rewrite is meant to replace what is on screen, including
      // unsaved edits, so both are set rather than leaving it to the sync.
      if (next) {
        setDraft(draftFrom(next));
        setSynced(draftFrom(next));
      }
      onSaved?.(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rewrite prompts");
    } finally {
      setRewriting(false);
    }
  };

  const disabled = busy || saving || rewriting;

  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-slate-300">
        Prompts
        <span className="ml-2 text-[11px] text-slate-500">
          sent to WanGP · editable
          {dirty ? " · unsaved changes" : ""}
        </span>
      </summary>

      <div className="mt-2 space-y-3">
        {FIELDS.map((field) => {
          const words = triggerWords?.[field.kind] ?? [];
          const isNegative = field.key.toLowerCase().includes("negative");
          const pending = isNegative
            ? []
            : words.filter((w) => !new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(draft[field.key]));

          return (
            <label key={field.key} className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">
                {field.label}
              </span>
              <textarea
                rows={field.rows}
                disabled={disabled}
                value={draft[field.key]}
                onChange={(e) =>
                  setDraft((current) => ({ ...current, [field.key]: e.target.value }))
                }
                className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent disabled:opacity-60"
              />
              {pending.length ? (
                <span className="block text-[10px] text-amber-300/80">
                  LoRA trigger words appended at generation: {pending.join(", ")}
                </span>
              ) : null}
            </label>
          );
        })}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save()}
            className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save prompts"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => setDraft(stored)}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            Revert
          </button>
          <button
            type="button"
            disabled={disabled || rewriting}
            onClick={() => void rewrite()}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
            title="Ask the prompt agents to write this scene's prompts again from its card"
          >
            {rewriting ? "Rewriting…" : "Regenerate these prompts"}
          </button>
          {saved && !dirty ? <span className="text-xs text-emerald-400">Saved.</span> : null}
          {error ? <span className="text-xs text-red-300">{error}</span> : null}
        </div>

        <p className="text-[10px] text-slate-600">
          Edits apply to this scene only and take effect on the next generation. Regenerating the
          storyboard rewrites them. <strong>Regenerate these prompts</strong> rewrites this scene
          alone, from its existing card — the card, the other scenes and their hand edits are left
          as they are.
        </p>

        {scene.prompts.promptQualityChecklist.length ? (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Quality checklist</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {scene.prompts.promptQualityChecklist.map((item) => (
                <li key={item} className="text-[11px] text-slate-500">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
