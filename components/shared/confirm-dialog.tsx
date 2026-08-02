"use client";

import { useCallback, useEffect, useId, useRef } from "react";

/**
 * A destructive confirmation, on the native `<dialog>` element.
 *
 * Native rather than hand-rolled: the browser already owns modality, focus
 * containment, the top layer and Escape, and every one of those is a thing this
 * app previously got wrong by rendering the confirmation inline in the list.
 * All supported browsers (Next 16 targets Chrome/Edge/Firefox 111+ and Safari
 * 16.4+) implement it, so there is no fallback path to maintain.
 *
 * Focus starts on Cancel: the destructive button is one Tab away, and a dialog
 * that opens with "delete" focused is one stray Enter from doing it.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  /** Also called for Escape and backdrop dismissal. */
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // `cancel` fires on Escape. A commit already in flight cannot be called off,
  // so the dialog stays put rather than implying the delete was stopped.
  const onDialogCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (!busy) onCancel();
    },
    [busy, onCancel],
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={onDialogCancel}
      onClose={() => {
        if (open && !busy) onCancel();
      }}
      className="max-w-md rounded-lg border border-red-500/40 p-0 backdrop:bg-slate-950/70"
    >
      <div className="space-y-3 p-4">
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        <div id={bodyId} className="space-y-2 text-xs text-slate-400">
          {children}
        </div>
        <div className="flex gap-2 pt-1">
          <button
            ref={cancelRef}
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
            onClick={onConfirm}
            className="min-h-[2.25rem] rounded-md bg-red-500/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? (busyLabel ?? "Working…") : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
