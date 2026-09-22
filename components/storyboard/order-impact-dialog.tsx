"use client";

import type { OrderImpact } from "@/lib/storyboard/order-impact";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/**
 * What a reorder will cost, stated before it happens.
 *
 * Written as consequences rather than mechanisms throughout: "scene 8's opening
 * will not match" is actionable, "the seam is stale" is not. Where a move costs
 * nothing the dialog says so and gets out of the way — a warning that fires
 * unconditionally is how people learn to dismiss the one that matters.
 */

const names = (scenes: OrderImpact["promptSeams"]): string =>
  scenes.map((s) => `${s.sceneNumber} (${s.title})`).join(", ");

const ARTIFACT_LABELS: Record<string, string> = {
  assembly: "the assembled cut",
  audioPlan: "the audio plan",
  animaticPlan: "the animatic",
};

export function OrderImpactDialog({
  open,
  title,
  confirmLabel,
  impact,
  busy = false,
  rewritePrompts,
  onRewritePromptsChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** Null while the preview is still being fetched. */
  impact: OrderImpact | null;
  busy?: boolean;
  rewritePrompts: boolean;
  onRewritePromptsChange: (next: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      tone="neutral"
      title={title}
      confirmLabel={confirmLabel}
      busy={busy}
      busyLabel="Moving…"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {impact === null ? (
        <p>Working out what this would affect…</p>
      ) : impact.clean ? (
        <p data-testid="impact-clean">
          Nothing else in this storyboard depends on where this scene sits, so nothing will need
          redoing.
        </p>
      ) : (
        <div className="space-y-2" data-testid="impact-consequences">
          <p className="text-slate-300">
            Nothing is deleted — every rendered frame, seed and LoRA choice stays with its scene.
            These are the things that will no longer line up:
          </p>
          <ul className="list-disc space-y-1.5 pl-4">
            {impact.inheritedFrames.length ? (
              <li>
                <strong className="text-amber-300/90">Frames already rendered:</strong> scene{" "}
                {names(impact.inheritedFrames)} opens on a picture carried over from the scene
                before it. After this that picture comes from a different scene, so the opening
                will not match until it is rendered again.
              </li>
            ) : null}
            {impact.promptSeams.length ? (
              <li>
                <strong>Opening prompts:</strong> scene {names(impact.promptSeams)} had its opening
                written to match the scene that used to come before it.
              </li>
            ) : null}
            {impact.wardrobe.length ? (
              <li>
                <strong className="text-amber-300/90">Wardrobe:</strong> scene{" "}
                {names(impact.wardrobe)} moves to the other side of a costume change, so the
                characters in it will be dressed differently from now on.
              </li>
            ) : null}
            {impact.staleArtifacts.length ? (
              <li>
                <strong>Out of date afterwards:</strong>{" "}
                {impact.staleArtifacts.map((a) => ARTIFACT_LABELS[a] ?? a).join(", ")}. Nothing is
                regenerated automatically.
              </li>
            ) : null}
          </ul>

          {impact.promptSeams.length ? (
            <label className="flex gap-2 pt-1 text-slate-300">
              <input
                type="checkbox"
                checked={rewritePrompts}
                disabled={busy}
                onChange={(e) => onRewritePromptsChange(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-canvas accent-accent"
                data-testid="rewrite-prompts"
              />
              <span>
                Rewrite the opening prompts for scene {names(impact.promptSeams)} to match their new
                neighbours.{" "}
                <span className="text-slate-500">
                  This replaces their current prompt text, including anything written by hand. No
                  frames are re-rendered either way.
                </span>
              </span>
            </label>
          ) : null}
        </div>
      )}
    </ConfirmDialog>
  );
}
