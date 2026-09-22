"use client";

/**
 * Rearranging the running order, from the top of a scene card.
 *
 * Two groups rather than a row of four: moving rearranges what exists and
 * inserting creates something new, and four identical-looking buttons invite
 * the wrong click.
 *
 * Every control names its scene. The visual position *is* the meaning of these
 * controls, so four buttons per card all reading "Move up" would tell a screen
 * reader nothing — and there are as many of them as there are scenes.
 */

const button =
  "min-h-[1.75rem] rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-300 " +
  "hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";

export function SceneOrderControls({
  sceneNumber,
  isFirst,
  isLast,
  busy = false,
  queueActive = false,
  onMove,
  onInsert,
}: {
  sceneNumber: number;
  isFirst: boolean;
  isLast: boolean;
  busy?: boolean;
  /** Reordering is refused server-side while a batch runs; say so up front. */
  queueActive?: boolean;
  onMove?: (direction: "up" | "down") => void;
  /** Absent until insertion ships; the pair renders disabled meanwhile. */
  onInsert?: (side: "before" | "after") => void;
}) {
  const locked = busy || queueActive;
  const lockReason = queueActive
    ? "Scenes cannot be rearranged while a generation queue is running."
    : undefined;

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="scene-order-controls"
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={button}
          aria-label={`Move scene ${sceneNumber} up`}
          disabled={locked || isFirst}
          onClick={() => onMove?.("up")}
          title={lockReason ?? (isFirst ? "This scene is already first." : undefined)}
        >
          ↑ Move up
        </button>
        <button
          type="button"
          className={button}
          aria-label={`Move scene ${sceneNumber} down`}
          disabled={locked || isLast}
          onClick={() => onMove?.("down")}
          title={lockReason ?? (isLast ? "This scene is already last." : undefined)}
        >
          ↓ Move down
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={button}
          aria-label={`Insert a scene before scene ${sceneNumber}`}
          disabled={locked || !onInsert}
          onClick={() => onInsert?.("before")}
          title={lockReason ?? (onInsert ? undefined : "Adding a scene by hand is coming soon.")}
        >
          + Insert before
        </button>
        <button
          type="button"
          className={button}
          aria-label={`Insert a scene after scene ${sceneNumber}`}
          disabled={locked || !onInsert}
          onClick={() => onInsert?.("after")}
          title={lockReason ?? (onInsert ? undefined : "Adding a scene by hand is coming soon.")}
        >
          + Insert after
        </button>
      </div>
    </div>
  );
}
