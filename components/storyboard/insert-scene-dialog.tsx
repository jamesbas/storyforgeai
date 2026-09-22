"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OrderImpact } from "@/lib/storyboard/order-impact";
import type { InsertSceneCard } from "@/lib/schemas/storyboard";

/**
 * Writing a new scene into an existing storyboard.
 *
 * A form rather than a confirmation, which is why it does not reuse
 * `ConfirmDialog`: that one opens with Cancel focused because its confirm
 * button destroys something, and this one has to open on the first field. The
 * native `<dialog>` underneath is the same, for the same reasons — the browser
 * owns modality, focus containment, the top layer and Escape.
 *
 * Three fields are required. A scene with no visual and no action gives the
 * prompt builders nothing to work from and renders the project's house style
 * over an empty shot, which reads as a bug rather than as an empty card.
 */

const field =
  "w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm text-slate-100 " +
  "outline-none focus:border-accent disabled:opacity-60";
const label = "text-[11px] uppercase tracking-wide text-slate-500";

type Draft = {
  title: string;
  visualDescription: string;
  actionDescription: string;
  sceneObjective: string;
  storyBeat: string;
  cameraMovement: string;
  transitionIn: string;
  transitionOut: string;
};

const EMPTY: Draft = {
  title: "",
  visualDescription: "",
  actionDescription: "",
  sceneObjective: "",
  storyBeat: "",
  cameraMovement: "",
  transitionIn: "",
  transitionOut: "",
};

export function InsertSceneDialog({
  open,
  anchorSceneNumber,
  side,
  impact,
  busy = false,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  anchorSceneNumber: number;
  side: "before" | "after";
  /** Null while the preview is still being fetched. */
  impact: OrderImpact | null;
  busy?: boolean;
  onSubmit: (card: InsertSceneCard, options: { writePrompts: boolean; rewriteFollower: boolean }) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [writePrompts, setWritePrompts] = useState(false);
  const [rewriteFollower, setRewriteFollower] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setDraft(EMPTY);
      setWritePrompts(false);
      setRewriteFollower(false);
      setTouched(false);
      dialog.showModal();
      firstRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const onDialogCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (!busy) onCancel();
    },
    [busy, onCancel],
  );

  const set = (key: keyof Draft) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const missing =
    !draft.title.trim() || !draft.visualDescription.trim() || !draft.actionDescription.trim();

  const submit = () => {
    setTouched(true);
    if (missing || busy) return;
    onSubmit(
      {
        title: draft.title.trim(),
        visualDescription: draft.visualDescription.trim(),
        actionDescription: draft.actionDescription.trim(),
        ...(draft.sceneObjective.trim() ? { sceneObjective: draft.sceneObjective.trim() } : {}),
        ...(draft.storyBeat.trim() ? { storyBeat: draft.storyBeat.trim() } : {}),
        ...(draft.cameraMovement.trim() ? { cameraMovement: draft.cameraMovement.trim() } : {}),
        ...(draft.transitionIn.trim() ? { transitionIn: draft.transitionIn.trim() } : {}),
        ...(draft.transitionOut.trim() ? { transitionOut: draft.transitionOut.trim() } : {}),
      },
      { writePrompts, rewriteFollower },
    );
  };

  const followerAffected = (impact?.promptSeams.length ?? 0) > 0;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onDialogCancel}
      onClose={() => {
        if (open && !busy) onCancel();
      }}
      className="w-[32rem] max-w-[92vw] rounded-lg border border-white/20 p-0 backdrop:bg-slate-950/70"
    >
      <div className="space-y-3 p-4">
        <h2 id={titleId} className="text-sm font-semibold">
          Add a scene {side} scene {anchorSceneNumber}
        </h2>
        <p className="text-[11px] text-slate-500">
          The piece gets one segment longer; the scenes around it keep everything they have
          already rendered.
        </p>

        <div className="space-y-2">
          <label className="block space-y-1">
            <span className={label}>Title</span>
            <input
              ref={firstRef}
              value={draft.title}
              disabled={busy}
              onChange={(e) => set("title")(e.target.value)}
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className={label}>Visual — what the shot shows</span>
            <textarea
              rows={3}
              value={draft.visualDescription}
              disabled={busy}
              onChange={(e) => set("visualDescription")(e.target.value)}
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className={label}>Action — what happens in it</span>
            <textarea
              rows={3}
              value={draft.actionDescription}
              disabled={busy}
              onChange={(e) => set("actionDescription")(e.target.value)}
              className={field}
            />
          </label>

          {touched && missing ? (
            <p className="text-[11px] text-red-300" data-testid="insert-missing">
              A title, a visual and an action are all needed — without them there is nothing for
              the prompts to describe.
            </p>
          ) : null}

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-400">Optional detail</summary>
            <div className="mt-2 space-y-2">
              <label className="block space-y-1">
                <span className={label}>Objective</span>
                <input
                  value={draft.sceneObjective}
                  disabled={busy}
                  onChange={(e) => set("sceneObjective")(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block space-y-1">
                <span className={label}>Story beat</span>
                <input
                  value={draft.storyBeat}
                  disabled={busy}
                  onChange={(e) => set("storyBeat")(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block space-y-1">
                <span className={label}>Camera</span>
                <input
                  value={draft.cameraMovement}
                  disabled={busy}
                  onChange={(e) => set("cameraMovement")(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block space-y-1">
                <span className={label}>Transition in</span>
                <input
                  value={draft.transitionIn}
                  disabled={busy}
                  onChange={(e) => set("transitionIn")(e.target.value)}
                  className={field}
                  placeholder="e.g. Cut to — declares this scene a new shot"
                />
              </label>
            </div>
          </details>
        </div>

        <div className="space-y-1.5 border-t border-white/10 pt-3 text-xs">
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={writePrompts}
              disabled={busy}
              onChange={(e) => setWritePrompts(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-canvas accent-accent"
              data-testid="insert-write-prompts"
            />
            <span className="text-slate-300">
              Write the prompts with the planning model.{" "}
              <span className="text-slate-500">
                Leave this off and the scene is created instantly from the deterministic builders,
                with no model call. You can regenerate its prompts from the card at any time.
              </span>
            </span>
          </label>

          {followerAffected ? (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={rewriteFollower}
                disabled={busy}
                onChange={(e) => setRewriteFollower(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-canvas accent-accent"
                data-testid="insert-rewrite-follower"
              />
              <span className="text-slate-300">
                Also rewrite the opening of the scene that now follows.{" "}
                <span className="text-slate-500">
                  Its opening was written to match the scene that used to come before it. This
                  replaces that text, including anything written by hand.
                </span>
              </span>
            </label>
          ) : null}
        </div>

        {impact && !impact.clean ? (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">
            {impact.inheritedFrames.length ? (
              <p data-testid="insert-frame-warning">
                Scene {impact.inheritedFrames.map((s) => s.sceneNumber).join(", ")} opens on a frame
                carried over from the scene before it. After this it will be carried from a
                different scene, so it will not match until re-rendered. Nothing is re-rendered
                automatically.
              </p>
            ) : null}
            {impact.wardrobe.length ? (
              <p className="mt-1">
                Scene {impact.wardrobe.map((s) => s.sceneNumber).join(", ")} crosses a costume
                change, so the characters in it will be dressed differently from now on.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-[2.25rem] rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:border-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="min-h-[2.25rem] rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add the scene"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
