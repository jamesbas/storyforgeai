"use client";

import { useId, useState } from "react";
import { LoraSelector } from "@/components/settings/lora-selector";
import type { SceneLoraOverride } from "@/lib/schemas/lora";

const EMPTY: SceneLoraOverride = { mode: "inherit", image: [], video: [] };

/**
 * Which radio is lit. "copy" is a way of *arriving* at an override, not a stored
 * mode — a copied scene saves as an ordinary override, so nothing has to resolve
 * a chain of scenes at generation time and editing one scene cannot silently
 * change another.
 */
type Choice = "inherit" | "override" | "copy";

const CHOICE_LABELS: Record<Choice, string> = {
  inherit: "Use storyboard LoRAs",
  override: "Override for this scene",
  copy: "Copy previous scene's LoRAs",
};

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
  previousLoras,
  busy = false,
  onSave,
}: {
  projectId: string;
  value?: SceneLoraOverride;
  /**
   * The immediately preceding scene's override, when it has one. Absent on the
   * first scene and whenever the previous scene inherits — there is then nothing
   * distinct to copy.
   */
  previousLoras?: SceneLoraOverride;
  busy?: boolean;
  onSave: (next: SceneLoraOverride) => void;
}) {
  const [draft, setDraft] = useState<SceneLoraOverride>(value ?? EMPTY);
  const [choice, setChoice] = useState<Choice>(value?.mode === "override" ? "override" : "inherit");
  const group = useId();
  const canCopy = previousLoras?.mode === "override";
  const choices: Choice[] = canCopy ? ["inherit", "override", "copy"] : ["inherit", "override"];
  const overriding = draft.mode === "override";

  const pick = (next: Choice) => {
    setChoice(next);
    if (next === "copy" && previousLoras) {
      setDraft({
        mode: "override",
        image: [...previousLoras.image],
        video: [...previousLoras.video],
      });
      return;
    }
    setDraft((current) => ({ ...current, mode: next === "inherit" ? "inherit" : "override" }));
  };

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
          {choices.map((mode) => (
            <label key={mode} className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`lora-mode-${projectId}-${group}`}
                checked={choice === mode}
                disabled={busy}
                onChange={() => pick(mode)}
              />
              {CHOICE_LABELS[mode]}
            </label>
          ))}
        </div>

        {overriding ? (
          <>
            {choice === "copy" ? (
              <p className="text-xs text-slate-400" data-testid="lora-copied-note">
                Copied the previous scene&apos;s selection. Adjust it below if you need to, then
                save.
              </p>
            ) : null}
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
