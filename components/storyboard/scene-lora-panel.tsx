"use client";

import { useState } from "react";
import { LoraSelector } from "@/components/settings/lora-selector";
import type { SceneLoraOverride } from "@/lib/schemas/lora";

const EMPTY: SceneLoraOverride = { mode: "inherit", image: [], video: [] };

/**
 * Per-scene LoRA override.
 *
 * Overriding replaces the storyboard-wide selection rather than adding to it,
 * so what the scene shows is exactly what it will generate with — no hidden
 * inherited entries stacking underneath.
 */
export function SceneLoraPanel({
  projectId,
  value,
  busy = false,
  onSave,
}: {
  projectId: string;
  value?: SceneLoraOverride;
  busy?: boolean;
  onSave: (next: SceneLoraOverride) => void;
}) {
  const [draft, setDraft] = useState<SceneLoraOverride>(value ?? EMPTY);
  const overriding = draft.mode === "override";

  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-slate-300">
        LoRAs
        <span className="ml-2 text-[11px] text-slate-500">
          {value?.mode === "override"
            ? `overridden (${value.image.length + value.video.length} selected)`
            : "using storyboard selection"}
        </span>
      </summary>

      <div className="mt-2 space-y-3">
        <div className="flex flex-wrap gap-4 text-xs text-slate-300">
          {(["inherit", "override"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`lora-mode-${projectId}-${JSON.stringify(value?.mode ?? "")}-${mode}`}
                checked={draft.mode === mode}
                disabled={busy}
                onChange={() => setDraft((current) => ({ ...current, mode }))}
              />
              {mode === "inherit" ? "Use storyboard LoRAs" : "Override for this scene"}
            </label>
          ))}
        </div>

        {overriding ? (
          <>
            <div className="space-y-1">
              <span className="text-xs text-slate-400">Image LoRAs</span>
              <LoraSelector
                projectId={projectId}
                kind="image"
                value={draft.image}
                disabled={busy}
                onChange={(next) => setDraft((current) => ({ ...current, image: next }))}
              />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-slate-400">Video LoRAs</span>
              <LoraSelector
                projectId={projectId}
                kind="video"
                value={draft.video}
                disabled={busy}
                onChange={(next) => setDraft((current) => ({ ...current, video: next }))}
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-500">
            This scene generates with whatever is selected in project settings.
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft)}
          className="rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-accent disabled:opacity-50"
        >
          Save scene LoRAs
        </button>
      </div>
    </details>
  );
}
