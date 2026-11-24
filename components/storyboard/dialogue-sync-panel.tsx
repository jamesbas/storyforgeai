"use client";

import { useState } from "react";
import type { ProposedLine } from "@/lib/agents/dialogue-sync";
import type { DialogueSyncApplyResult, DialogueSyncPreview } from "@/lib/schemas/dialogue-sync";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

type LineChoice = ProposedLine & { include: boolean };
type SceneChoice = { include: boolean; lines: LineChoice[] };

const STATUS_LABEL: Record<ProposedLine["status"], string> = {
  unchanged: "same as the card",
  reworded: "reworded in the prompt",
  new: "not on the card",
};

const SPEAKER_NOTE: Record<ProposedLine["speakerFrom"], string | null> = {
  card: null,
  named: null,
  guessed: "speaker guessed — check it",
  unknown: "choose who says this",
};

/**
 * Copy the dialogue a video prompt actually says back onto its scene card.
 *
 * The card's dialogue — not the prompt — decides which quoted words are spoken
 * as dialogue, who says them and whose voice they are in, so a line reworded
 * only in the prompt is a line generation does not recognise. This previews
 * the card as it would be after copying, lets every guessed speaker be checked
 * and any line be left out, and saves nothing until Apply.
 */
export function DialogueSyncPanel({
  projectId,
  sceneIds,
  scope,
  disabled = false,
  disabledReason,
  onApplied,
}: {
  projectId: string;
  /** The scenes to read; omit for every scene in the project. */
  sceneIds?: string[];
  scope: "scene" | "project";
  disabled?: boolean;
  disabledReason?: string;
  onApplied?: (record: ProjectRecord) => void;
}) {
  const [preview, setPreview] = useState<DialogueSyncPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, SceneChoice>>({});
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dialogue-sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sceneIds ? { sceneIds } : {}),
      });
      const data = (await res.json().catch(() => null)) as (DialogueSyncPreview & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? `Failed to read the video prompts (HTTP ${res.status})`);
      setPreview(data);
      setChoices(Object.fromEntries(data.scenes.map((scene) => [scene.sceneId, {
        // Emptying a card is rarely what someone wants from a bulk copy: it
        // usually means the prompt writer left the line out.
        include: !scene.emptiesDialogue,
        lines: scene.after.map((line) => ({ ...line, include: true })),
      }])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read the video prompts");
    } finally {
      setLoading(false);
    }
  };

  const picked = preview?.scenes.filter((scene) => choices[scene.sceneId]?.include) ?? [];
  const unresolved = picked.filter((scene) =>
    choices[scene.sceneId]!.lines.some((line) => line.include && !line.character.trim()));
  const canApply = picked.length > 0 && unresolved.length === 0 && !applying;

  const apply = async () => {
    if (!preview || !canApply) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dialogue-sync`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenes: picked.map((scene) => ({
            sceneId: scene.sceneId,
            sceneHash: scene.sceneHash,
            dialogue: choices[scene.sceneId]!.lines
              .filter((line) => line.include)
              .map((line) => ({ character: line.character, line: line.line })),
          })),
        }),
      });
      const data = (await res.json().catch(() => null)) as (DialogueSyncApplyResult & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? `Failed to update the scene cards (HTTP ${res.status})`);
      onApplied?.(data.record);
      setPreview(null);
      setNotice(`Updated the dialogue on scene ${data.updated.join(", ")}. Render the video again to use it.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update the scene cards");
    } finally {
      setApplying(false);
    }
  };

  const setScene = (sceneId: string, change: (current: SceneChoice) => SceneChoice) =>
    setChoices((current) => ({ ...current, [sceneId]: change(current[sceneId]!) }));
  const setLine = (sceneId: string, index: number, change: Partial<LineChoice>) =>
    setScene(sceneId, (scene) => ({
      ...scene,
      lines: scene.lines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    }));

  const button = "rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50";
  const label = scope === "scene"
    ? "Copy dialogue from the video prompt to the scene card…"
    : "Copy dialogue from every video prompt to its scene card…";

  return (
    <div className="space-y-2" data-testid={`dialogue-sync-${scope}`}>
      {!preview ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={disabled || loading} onClick={() => void load()}
            title={disabled ? disabledReason : "Preview first — nothing is changed until you apply it"}>
            {loading ? "Reading the video prompt…" : label}
          </button>
          {disabled && disabledReason ? <span className="text-[11px] text-slate-500">{disabledReason}</span> : null}
          {notice ? <span className="text-xs text-emerald-400">{notice}</span> : null}
        </div>
      ) : (
        <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs" role="region"
          aria-label="Dialogue copy preview">
          <p className="text-amber-200">
            <strong>This replaces the dialogue on the scene card{scope === "project" ? "s" : ""} with what the
            video prompt{scope === "project" ? "s say" : " says"}.</strong> The card&apos;s dialogue decides which
            quoted words are spoken as dialogue, who says each line and whose voice sample is used, so a line
            changed only in the prompt is not treated as dialogue. The prompts themselves are not changed.
            Check each speaker below — guesses are marked — and untick anything you don&apos;t want.
            Nothing is saved until you press Apply.
          </p>

          {scope === "project" ? (
            <p className="text-slate-400">
              {preview.scenes.length} scene{preview.scenes.length === 1 ? "" : "s"} would change ·{" "}
              {preview.unchanged} already match{preview.unchanged === 1 ? "es" : ""}
              {preview.skipped.length ? ` · ${preview.skipped.length} skipped` : ""}
            </p>
          ) : null}
          {preview.skipped.map((skip) => (
            <p key={skip.sceneId} className="text-slate-400">Scene {skip.sceneNumber}: {skip.reason}</p>
          ))}
          {preview.scenes.length === 0 ? (
            <p className="text-slate-300">
              {preview.skipped.length && !preview.unchanged
                ? "Nothing to copy."
                : "The scene card already has the dialogue the video prompt says. Nothing to change."}
            </p>
          ) : null}

          {preview.scenes.map((scene) => {
            const choice = choices[scene.sceneId]!;
            return (
              <div key={scene.sceneId} className="space-y-2 rounded border border-white/10 bg-canvas/40 p-2">
                <label className="flex items-center gap-2 font-medium text-slate-200">
                  {scope === "project" ? (
                    <input type="checkbox" checked={choice.include}
                      onChange={(e) => setScene(scene.sceneId, (s) => ({ ...s, include: e.target.checked }))} />
                  ) : null}
                  Scene {scene.sceneNumber} — {scene.title}
                </label>
                {scene.emptiesDialogue ? (
                  <p className="text-amber-300">
                    The video prompt quotes no speech, so copying would remove all of this scene&apos;s dialogue.
                    That usually means the prompt left a line out rather than that the scene is silent
                    {scope === "project" ? ", so this scene is not ticked" : ""}.
                  </p>
                ) : null}
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">On the card now</p>
                  <ul className="mt-1 space-y-0.5 text-slate-400">
                    {scene.before.length
                      ? scene.before.map((line, i) => <li key={i}>{line.character}: “{line.line}”</li>)
                      : <li>(no dialogue)</li>}
                  </ul>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">After copying</p>
                  <ul className="mt-1 space-y-1">
                    {choice.lines.map((line, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2">
                        <input type="checkbox" aria-label={`Keep line ${i + 1}`} checked={line.include}
                          disabled={!choice.include}
                          onChange={(e) => setLine(scene.sceneId, i, { include: e.target.checked })} />
                        <select value={line.character} disabled={!choice.include || !line.include}
                          aria-label={`Speaker of line ${i + 1}`}
                          onChange={(e) => setLine(scene.sceneId, i, { character: e.target.value })}
                          className={`rounded border bg-canvas px-1 py-0.5 ${
                            line.include && !line.character ? "border-red-400" : "border-white/15"}`}>
                          <option value="">Choose speaker…</option>
                          {[...new Set([...scene.speakers, ...(line.character ? [line.character] : [])])].map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                        <span className={line.include ? "text-slate-200" : "text-slate-500 line-through"}>
                          “{line.line}”
                        </span>
                        <span className="text-[10px] text-slate-500">{STATUS_LABEL[line.status]}</span>
                        {SPEAKER_NOTE[line.speakerFrom] ? (
                          <span className="text-[10px] text-amber-300">{SPEAKER_NOTE[line.speakerFrom]}</span>
                        ) : null}
                        {line.replaces ? (
                          <span className="w-full pl-6 text-[10px] text-slate-500">replaces “{line.replaces}”</span>
                        ) : null}
                      </li>
                    ))}
                    {choice.lines.length === 0 ? <li className="text-slate-400">(no dialogue)</li> : null}
                  </ul>
                </div>
                {scene.removed.length ? (
                  <p className="text-slate-400">
                    Removed, because the video prompt doesn&apos;t say {scene.removed.length === 1 ? "it" : "them"}:{" "}
                    {scene.removed.map((line) => `${line.character}: “${line.line}”`).join(" · ")}
                  </p>
                ) : null}
                {scene.kept.length ? (
                  <p className="text-slate-500">
                    Kept as stage directions: {scene.kept.map((line) => `${line.character}: ${line.line}`).join(" · ")}
                  </p>
                ) : null}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!canApply} onClick={() => void apply()}
              className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {applying ? "Applying…" : `Apply to ${picked.length} scene card${picked.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" className={button} disabled={applying} onClick={() => setPreview(null)}>
              Cancel
            </button>
            {unresolved.length ? (
              <span className="text-amber-300">
                Choose a speaker for every ticked line in scene {unresolved.map((s) => s.sceneNumber).join(", ")}.
              </span>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
    </div>
  );
}
