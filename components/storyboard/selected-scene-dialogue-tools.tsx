"use client";

import { useId, useState } from "react";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import { DIALOGUE_MODE_LABELS } from "@/lib/schemas/card-feedback";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import { DIALOGUE_MODES, type DialogueMode } from "@/lib/types";

type RewriteResponse = {
  record?: ProjectRecord;
  updatedSceneIds?: string[];
  skippedSceneIds?: string[];
  warnings?: Record<string, string[]>;
  promptsRewritten?: boolean;
  promptError?: string;
  error?: string;
};

/**
 * Rewrite the dialogue of several scenes at once, without touching their
 * pictures.
 *
 * "Fill short speaking scenes" is the common case: a storyboard written before
 * dialogue modes, or by a model that kept every exchange to two remarks, has
 * many scenes whose speech covers a fraction of the clip.
 */
export function SelectedSceneDialogueTools({
  projectId,
  scenes,
  rendersVideo,
  disabled,
  onSaved,
  onBusyChange,
}: {
  projectId: string;
  scenes: readonly Scene[];
  rendersVideo: boolean;
  disabled: boolean;
  onSaved: (record: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [picks, setPicks] = useState<string[]>([]);
  const [mode, setMode] = useState<DialogueMode | "">("");
  const [guidance, setGuidance] = useState("");
  const [updateVideo, setUpdateVideo] = useState(rendersVideo);
  const [pending, setPending] = useState<"picked" | "short" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = disabled || pending !== null;
  const numberOf = (sceneId: string) => scenes.find((scene) => scene.id === sceneId)?.sceneNumber;

  const send = async (kind: "picked" | "short") => {
    setPending(kind);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dialogue/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(picks.length ? { sceneIds: picks } : {}),
          ...(kind === "short" ? { onlyUnderCovered: true } : {}),
          ...(mode ? { modeOverride: mode } : {}),
          ...(guidance.trim() ? { instruction: guidance.trim() } : {}),
          rewriteVideoPrompts: updateVideo,
        }),
      });
      const body = (await res.json().catch(() => null)) as RewriteResponse | null;
      if (!res.ok || !body?.record) throw new Error(body?.error ?? `Could not rewrite the dialogue (HTTP ${res.status}).`);
      onSaved(body.record);
      const updated = (body.updatedSceneIds ?? []).map(numberOf).filter(Boolean);
      const short = Object.keys(body.warnings ?? {}).map(numberOf).filter(Boolean);
      setNotice(updated.length
        ? `Dialogue rewritten for scene ${updated.join(", ")}` +
          (body.promptsRewritten ? ", and their video prompts updated." : ".") +
          (short.length ? ` Scene ${short.join(", ")} still need a look.` : "")
        : kind === "short" ? "No speaking scene was short for its mode." : "The writer kept the existing dialogue.");
      if (body.promptError) setError(body.promptError);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rewrite the dialogue.");
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  };

  const scope = picks.length ? `${picks.length} picked scene${picks.length === 1 ? "" : "s"}` : "all scenes";

  return (
    <details className="mt-3 rounded-md border border-white/10 bg-black/20" data-testid="selected-scene-dialogue-tools">
      <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
        Rewrite dialogue for selected scenes
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <p className="text-xs text-slate-500">
          The Dialogue Writer rewrites what the picked scenes say, one scene at a time and in order, so
          each continues from the one before. Keyframes and image prompts are not touched. Pick no
          scenes to cover the whole storyboard.
        </p>
        <ScenePicker scenes={scenes} picked={picks} onChange={setPicks} testId="dialogue-scene-picker" />
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-slate-400">Dialogue mode</span>
            <select
              value={mode}
              disabled={locked}
              aria-label="Dialogue mode for the picked scenes"
              onChange={(e) => setMode(e.target.value as DialogueMode | "")}
              className="rounded-md border border-white/15 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            >
              <option value="">Keep each scene&apos;s mode</option>
              {DIALOGUE_MODES.map((value) => (
                <option key={value} value={value}>{DIALOGUE_MODE_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-guidance`} className="min-w-[16rem] flex-1 space-y-1">
            <span className="block text-slate-400">Guidance <span className="text-slate-500">(optional)</span></span>
            <input
              id={`${id}-guidance`}
              type="text"
              value={guidance}
              maxLength={500}
              disabled={locked}
              placeholder="e.g. let the argument build across these scenes"
              onChange={(e) => setGuidance(e.target.value)}
              className="w-full rounded-md border border-white/15 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            />
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" checked={updateVideo} disabled={locked} onChange={(e) => setUpdateVideo(e.target.checked)} />
          Also update their video prompts
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={locked || picks.length === 0}
            onClick={() => void send("picked")}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
          >
            {pending === "picked" ? "Rewriting dialogue…" : `Rewrite dialogue for ${scope}`}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => void send("short")}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
          >
            {pending === "short" ? "Filling short scenes…" : `Fill short speaking scenes (${scope})`}
          </button>
        </div>
        {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
        {notice ? <p role="status" className="text-xs text-green-300">{notice}</p> : null}
      </div>
    </details>
  );
}
