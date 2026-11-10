"use client";

import { useId, useState } from "react";
import {
  FEEDBACK_FIELD_LABELS,
  FEEDBACK_SCOPE_LABELS,
  type SceneFeedbackPreview,
  type SceneFeedbackScope,
} from "@/lib/schemas/scene-feedback";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

export function SceneFeedbackPanel({
  scene,
  projectId,
  rendersVideo = true,
  busy = false,
  onSaved,
  onBusyChange,
}: {
  scene: Scene;
  projectId: string;
  rendersVideo?: boolean;
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [scope, setScope] = useState<SceneFeedbackScope>("keyframes");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<"preview" | "apply" | null>(null);
  const [preview, setPreview] = useState<{ value: SceneFeedbackPreview; sceneSnapshot: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const disabled = busy || pending !== null;
  const stale = preview !== null && preview.sceneSnapshot !== JSON.stringify(scene);
  const hasVideo = rendersVideo && scene.prompts.videoPromptFamily !== "deferred";
  const endpoint = `/api/projects/${projectId}/scenes/${scene.id}/feedback`;

  const resetPreview = () => {
    setPreview(null);
    setError(null);
    setSaved(false);
  };

  const requestPreview = async () => {
    setPending("preview");
    onBusyChange?.(true);
    resetPreview();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, feedback }),
      });
      const body = (await res.json().catch(() => null)) as (SceneFeedbackPreview & { error?: string }) | null;
      if (!res.ok || !body?.proposal || !Array.isArray(body.changes)) {
        throw new Error(body?.error ?? `Could not prepare feedback changes (HTTP ${res.status}).`);
      }
      setPreview({ value: body, sceneSnapshot: JSON.stringify(scene) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare feedback changes.");
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  };

  const apply = async () => {
    if (!preview || stale) return;
    setPending("apply");
    onBusyChange?.(true);
    setError(null);
    try {
      const { scope: previewScope, sourceHash, proposal } = preview.value;
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: previewScope, sourceHash, proposal }),
      });
      const body = (await res.json().catch(() => null)) as (ProjectRecord & { error?: string }) | null;
      if (!res.ok || !body?.project) {
        throw new Error(body?.error ?? `Could not save feedback changes (HTTP ${res.status}).`);
      }
      setPreview(null);
      setSaved(true);
      onSaved?.(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save feedback changes.");
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  };

  return (
    <details className="mt-3 rounded-md border border-sky-400/20 bg-black/20" data-testid="scene-feedback-panel">
      <summary className="cursor-pointer px-3 py-2 text-xs text-sky-200">Refine with feedback</summary>
      <div className="space-y-3 border-t border-white/10 p-3 text-xs">
        <p className="text-slate-400">
          Describe what looks wrong or the result you want. The planning model will propose prompt
          changes for you to review, not regenerate media. Uses saved prompts; save any manual edits first.
        </p>
        <div>
          <label htmlFor={`${id}-scope`} className="mb-1 block text-slate-300">Feedback target</label>
          <select
            id={`${id}-scope`}
            value={scope}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "keyframes" || next === "start" || next === "end" || next === "video") {
                setScope(next);
                resetPreview();
              }
            }}
            className="rounded-md border border-white/15 bg-slate-950 px-2 py-1.5 text-slate-200 disabled:opacity-50"
          >
            {(["keyframes", "start", "end", "video"] as const).map((value) => (
              <option key={value} value={value} disabled={value === "video" && !hasVideo}>
                {FEEDBACK_SCOPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-feedback`} className="mb-1 block text-slate-300">What should change?</label>
          <textarea
            id={`${id}-feedback`}
            value={feedback}
            onChange={(e) => { setFeedback(e.target.value); resetPreview(); }}
            disabled={disabled}
            maxLength={4000}
            rows={3}
            placeholder="For example: In the end frame she should be holding the cup in her left hand, not leaving it on the table."
            className="w-full rounded-md border border-white/15 bg-slate-950 p-2 text-slate-200 disabled:opacity-50"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Text-only: your observations guide the correction; no images are sent.
            {scope !== "video" && hasVideo ? " Keyframe changes also get a video-motion review." : ""}
            {" "}The scene card is not rewritten.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || !feedback.trim() || (scope === "video" && !hasVideo)}
          onClick={() => void requestPreview()}
          className="rounded-md border border-sky-400/40 px-3 py-1.5 text-sky-200 hover:border-accent disabled:opacity-50"
        >
          {pending === "preview" ? "Preparing preview..." : "Preview changes"}
        </button>
        {error ? <p role="alert" className="text-red-300">{error}</p> : null}
        {saved ? (
          <p role="status" className="text-green-300">
            Prompts saved. Existing media is unchanged; regenerate the affected keyframes or video when ready.
          </p>
        ) : null}
        {preview ? (
          <div className="space-y-3 rounded-md border border-sky-400/30 bg-sky-400/5 p-3" data-testid="scene-feedback-preview">
            <p className="text-sky-100">{preview.value.proposal.summary}</p>
            {hasVideo ? (
              <p className="text-slate-300">
                <strong>Video impact:</strong> {preview.value.proposal.videoReview.explanation}
              </p>
            ) : null}
            {preview.value.changes.map((change) => (
              <details key={`${change.sceneId}:${change.field}`} open className="rounded border border-white/10 p-2">
                <summary className="cursor-pointer text-slate-200">
                  Scene {change.sceneNumber}: {FEEDBACK_FIELD_LABELS[change.field]}
                  {change.carried ? " (carried opening)" : ""}
                </summary>
                <p className="my-2 text-[11px] text-slate-400">{change.reason}</p>
                <div className="grid gap-2 lg:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[11px] text-red-200">Current</p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-slate-400">
                      {change.before || "(empty)"}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-green-200">Proposed</p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-slate-200">
                      {change.after}
                    </pre>
                  </div>
                </div>
              </details>
            ))}
            {preview.value.warnings.length ? (
              <div className="rounded border border-amber-400/30 p-2 text-amber-200">
                <p>Review these advisories before applying. Feedback can differ from the existing scene card:</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {preview.value.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            ) : null}
            {stale ? (
              <p role="alert" className="text-amber-200">This scene changed after the preview. Preview again before applying.</p>
            ) : null}
            <p className="text-[11px] text-slate-400">
              Accept these changes together to keep the prompts consistent. Existing images and clips are kept.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disabled || stale}
                onClick={() => void apply()}
                className="rounded-md border border-green-400/40 px-3 py-1.5 text-green-200 hover:border-accent disabled:opacity-50"
              >
                {pending === "apply" ? "Saving..." : "Accept changes"}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={resetPreview}
                className="rounded-md border border-white/15 px-3 py-1.5 text-slate-300 hover:border-white/30 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
