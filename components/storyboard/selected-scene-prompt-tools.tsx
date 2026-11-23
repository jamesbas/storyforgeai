"use client";

import { useId, useState } from "react";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import {
  CARD_CHANGE_LABELS,
  type CardFeedbackApplyResult,
  type CardFeedbackPreview,
} from "@/lib/schemas/card-feedback";
import {
  FEEDBACK_TARGET_LABELS,
  rewriteOptionsFor,
  type BulkFeedbackResult,
  type FeedbackTarget,
} from "@/lib/schemas/scene-feedback";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

type Pending = "refine" | "cards-preview" | "cards-apply" | null;

/**
 * Rewrite or refine the prompts of the scenes picked, and only those.
 *
 * With the feedback box empty this re-runs the prompt agents from the cards,
 * limited to the prompts ticked. With feedback it is the per-scene "Refine
 * with feedback", swept across the selection and saved straight away: the
 * person is correcting something the storyboard artist got wrong in many
 * places, and a preview per scene is the hand-editing it exists to avoid.
 *
 * When the mistake is in the cards themselves, the feedback can correct the
 * cards instead. That change is previewed, because every later rewrite reads
 * the card; accepting it saves the cards and rewrites the ticked prompts from
 * them, so the prompts and their source agree.
 */
export function SelectedScenePromptTools({
  projectId,
  scenes,
  rendersVideo,
  disabled,
  rewriting,
  onRewrite,
  onSaved,
  onBusyChange,
}: {
  projectId: string;
  scenes: readonly Scene[];
  rendersVideo: boolean;
  disabled: boolean;
  rewriting: boolean;
  onRewrite: (sceneIds: string[], request: ReturnType<typeof rewriteOptionsFor>) => Promise<void>;
  onSaved: (record: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [picks, setPicks] = useState<string[]>([]);
  const [ticked, setTicked] = useState<FeedbackTarget[]>(["start", "end", "video"]);
  const [feedback, setFeedback] = useState("");
  const [correctCards, setCorrectCards] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkFeedbackResult | null>(null);
  const [cardPreview, setCardPreview] = useState<{ value: CardFeedbackPreview; snapshot: string } | null>(null);
  const [cardsSaved, setCardsSaved] = useState<string | null>(null);

  const available = (["start", "end", "video"] as const).filter((t) => t !== "video" || rendersVideo);
  const targets = available.filter((t) => ticked.includes(t));
  const withFeedback = feedback.trim().length > 0;
  const cardMode = withFeedback && correctCards;
  const locked = disabled || pending !== null || rewriting;
  const count = `${picks.length} scene${picks.length === 1 ? "" : "s"}`;
  const stale = cardPreview !== null && cardPreview.snapshot !== JSON.stringify(scenes);

  const clearOutcome = () => {
    setError(null);
    setResult(null);
    setCardPreview(null);
    setCardsSaved(null);
  };

  const toggle = (target: FeedbackTarget, on: boolean) =>
    setTicked((current) => on ? [...current, target] : current.filter((t) => t !== target));

  /** One request at a time, with the rest of the storyboard told it is busy. */
  const send = async <T,>(kind: Exclude<Pending, null>, url: string, method: string, payload: unknown, fallback: string) => {
    setPending(kind);
    onBusyChange?.(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `${fallback} (HTTP ${res.status}).`);
      return body;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return null;
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  };

  const refine = async () => {
    const body = await send<{ record?: ProjectRecord } & Partial<BulkFeedbackResult>>(
      "refine", `/api/projects/${projectId}/feedback`, "POST",
      { sceneIds: picks, targets, feedback }, "Could not refine the prompts",
    );
    if (!body?.record) return;
    setResult({ refined: body.refined ?? [], failed: body.failed ?? [] });
    onSaved(body.record);
  };

  const previewCards = async () => {
    const snapshot = JSON.stringify(scenes);
    const body = await send<CardFeedbackPreview>(
      "cards-preview", `/api/projects/${projectId}/feedback/cards`, "POST",
      { sceneIds: picks, feedback }, "Could not prepare card corrections",
    );
    if (body?.scenes) setCardPreview({ value: body, snapshot });
  };

  const applyCards = async () => {
    if (!cardPreview || stale) return;
    const { value } = cardPreview;
    const body = await send<CardFeedbackApplyResult>(
      "cards-apply", `/api/projects/${projectId}/feedback/cards`, "PUT",
      { sourceHash: value.sourceHash, targets, edits: value.scenes.map((scene) => scene.edit) },
      "Could not save the card corrections",
    );
    if (!body?.record) return;
    setCardPreview(null);
    onSaved(body.record);
    const named = value.scenes.map((scene) => `scene ${scene.sceneNumber}`).join(", ");
    if (body.promptsRewritten) setCardsSaved(`Cards saved and prompts rewritten for ${named}. Regenerate their keyframes or video when ready.`);
    else setError(body.promptError ?? "The scene cards were saved, but their prompts were not rewritten.");
  };

  const run = () => {
    clearOutcome();
    if (cardMode) void previewCards();
    else if (withFeedback) void refine();
    else void onRewrite(picks, rewriteOptionsFor(targets));
  };

  const advisories = result?.refined.filter((entry) => entry.warnings.length) ?? [];

  return (
    <details className="mt-3 rounded-md border border-white/10 bg-black/20" data-testid="selected-scene-prompt-tools">
      <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
        Rewrite prompts for selected scenes
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <p className="text-xs text-slate-500">
          Rewrites the ticked prompts for the scenes you pick. Every other scene keeps its wording,
          including any hand edits, which is why you&apos;d use this instead of rewriting all of them.
        </p>
        <ScenePicker
          scenes={scenes}
          picked={picks}
          onChange={(next) => { setPicks(next); setCardPreview(null); }}
          testId="prompt-scene-picker"
        />
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
          <legend className="mb-1 text-slate-400">Prompts to rewrite</legend>
          {(["start", "end", "video"] as const).map((target) => (
            <label key={target} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={targets.includes(target)}
                disabled={locked || !available.includes(target)}
                onChange={(e) => toggle(target, e.target.checked)}
              />
              {FEEDBACK_TARGET_LABELS[target]}
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor={`${id}-feedback`} className="mb-1 block text-xs text-slate-300">
            Refine with feedback <span className="text-slate-500">(optional)</span>
          </label>
          <textarea
            id={`${id}-feedback`}
            value={feedback}
            onChange={(e) => { setFeedback(e.target.value); setCardPreview(null); }}
            disabled={locked}
            maxLength={4000}
            rows={3}
            placeholder="For example: Mara wears her glasses in every shot, and the kitchen is lit by a single warm lamp, not daylight."
            className="w-full rounded-md border border-white/15 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50"
          />
          <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={correctCards}
              disabled={locked || !withFeedback}
              onChange={(e) => { setCorrectCards(e.target.checked); setCardPreview(null); }}
            />
            Also correct the scene cards
          </label>
          <p className="mt-1 text-[11px] text-slate-500">
            {!withFeedback
              ? "Leave this empty to re-run the prompt agents from each scene's card. Add feedback to have the planning model correct the existing prompts instead."
              : cardMode
                ? "For mistakes in the cards themselves, such as the action, who is in the shot, dialogue or wardrobe. The planning model corrects each picked scene's card and wardrobe changes to follow this feedback, and you review the card changes first. Accepting saves them and rewrites the ticked prompts from the corrected cards. Wardrobe changes carry forward to later scenes, as they do when set by hand."
                : "The planning model edits each picked scene's ticked prompts to follow this feedback and saves the result straight away, with no preview. Only the ticked prompts change. The scene cards and existing media are kept."}
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={locked || picks.length === 0 || targets.length === 0}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
        >
          {pending === "refine"
            ? "Refining prompts…"
            : pending === "cards-preview"
              ? "Preparing card changes…"
              : pending === "cards-apply"
                ? "Saving cards and rewriting prompts…"
                : rewriting
                  ? "Rewriting prompts…"
                  : cardMode
                    ? `Preview card changes for ${count}`
                    : withFeedback
                      ? `Refine ${count} with feedback`
                      : `Rewrite ${count}' prompts`}
        </button>
        {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
        {cardsSaved ? <p role="status" className="text-xs text-green-300">{cardsSaved}</p> : null}
        {cardPreview ? (
          <CardPreview
            preview={cardPreview.value}
            stale={stale}
            busy={pending !== null}
            targets={targets}
            onAccept={() => void applyCards()}
            onDiscard={() => setCardPreview(null)}
          />
        ) : null}
        {result ? (
          <div role="status" className="space-y-1 text-xs" data-testid="selected-scene-feedback-result">
            {result.refined.length ? (
              <p className="text-green-300">
                Refined {result.refined.map((entry) => `scene ${entry.sceneNumber}`).join(", ")}. Regenerate
                their keyframes or video when ready.
              </p>
            ) : null}
            {result.failed.length ? <FailedList failed={result.failed} title="Not changed:" /> : null}
            {advisories.length ? (
              <details className="text-slate-400">
                <summary className="cursor-pointer">Advisories ({advisories.length} scene{advisories.length === 1 ? "" : "s"})</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {advisories.flatMap((entry) => entry.warnings.map((warning) => (
                    <li key={`${entry.sceneId}:${warning}`}>Scene {entry.sceneNumber}: {warning}</li>
                  )))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function FailedList({ failed, title }: { failed: BulkFeedbackResult["failed"]; title: string }) {
  return (
    <div className="text-xs text-amber-200">
      <p>{title}</p>
      <ul className="list-disc pl-4">
        {failed.map((entry) => (
          <li key={entry.sceneId}>Scene {entry.sceneNumber}: {entry.error}</li>
        ))}
      </ul>
    </div>
  );
}

function CardPreview({
  preview,
  stale,
  busy,
  targets,
  onAccept,
  onDiscard,
}: {
  preview: CardFeedbackPreview;
  stale: boolean;
  busy: boolean;
  targets: readonly FeedbackTarget[];
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const ticked = targets.map((t) => FEEDBACK_TARGET_LABELS[t].toLowerCase()).join(", ");
  return (
    <div className="space-y-3 rounded-md border border-sky-400/30 bg-sky-400/5 p-3 text-xs" data-testid="card-feedback-preview">
      {preview.scenes.map((scene) => (
        <details key={scene.sceneId} open className="rounded border border-white/10 p-2">
          <summary className="cursor-pointer text-slate-200">Scene {scene.sceneNumber}</summary>
          <p className="my-2 text-sky-100">{scene.summary}</p>
          {scene.changes.length === 0 ? (
            <p className="text-slate-400">No card change needed. Its ticked prompts are still rewritten from the card.</p>
          ) : scene.changes.map((change) => (
            <div key={change.field} className="mt-2">
              <p className="text-slate-300">{CARD_CHANGE_LABELS[change.field]}</p>
              {change.reason ? <p className="text-[11px] text-slate-400">{change.reason}</p> : null}
              <div className="mt-1 grid gap-2 lg:grid-cols-2">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-slate-400">
                  {change.before || "(empty)"}
                </pre>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-slate-200">
                  {change.after || "(empty)"}
                </pre>
              </div>
            </div>
          ))}
        </details>
      ))}
      {preview.failed.length ? (
        <FailedList failed={preview.failed} title="Could not correct (left out; their cards and prompts are unchanged):" />
      ) : null}
      {preview.warnings.length ? (
        <ul className="list-disc space-y-1 pl-4 text-amber-200">
          {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {stale ? (
        <p role="alert" className="text-amber-200">The storyboard changed after this preview. Preview again before accepting.</p>
      ) : null}
      <p className="text-[11px] text-slate-400">
        Accepting saves these cards and wardrobe changes together, then rewrites the {ticked} prompt
        {targets.length === 1 ? "" : "s"} of {preview.scenes.length === 1 ? "this scene" : "these scenes"} from
        the corrected cards. Existing images and clips are kept.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || stale || preview.scenes.length === 0 || targets.length === 0}
          onClick={onAccept}
          className="rounded-md border border-green-400/40 px-3 py-1.5 text-green-200 hover:border-accent disabled:opacity-50"
        >
          Accept and rewrite prompts
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="rounded-md border border-white/15 px-3 py-1.5 text-slate-300 hover:border-white/30 disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
