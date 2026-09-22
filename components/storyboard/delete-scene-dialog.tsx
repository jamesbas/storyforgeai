"use client";

import type { OrderImpact } from "@/lib/storyboard/order-impact";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/**
 * Removing a scene.
 *
 * The destructive one of the three, so it keeps `ConfirmDialog`'s default
 * `danger` tone and its focus-on-Cancel behaviour. What it has to be honest
 * about is the part people assume and get wrong: the scene's rendered frames
 * and clips are **not** deleted from disk, they simply stop being reachable
 * from the app — the same bargain project deletion already strikes, because
 * media is expensive to reproduce.
 */
export function DeleteSceneDialog({
  open,
  sceneNumber,
  title,
  impact,
  hadMedia,
  cues,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  sceneNumber: number;
  title: string;
  /** Null while the preview is still being fetched. */
  impact: OrderImpact | null;
  hadMedia: boolean;
  cues: number;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const followers = impact?.inheritedFrames ?? [];

  return (
    <ConfirmDialog
      open={open}
      title={`Delete scene ${sceneNumber} — ${title}?`}
      confirmLabel="Delete the scene"
      busy={busy}
      busyLabel="Deleting…"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {impact === null ? (
        <p>Working out what this would affect…</p>
      ) : (
        <div className="space-y-2" data-testid="delete-consequences">
          <p>
            The scenes after it move up, and the piece gets one segment shorter. Everything the
            other scenes have rendered stays exactly as it is.
          </p>

          <ul className="list-disc space-y-1.5 pl-4">
            <li>
              Its card, prompts, seed and LoRA choices go, and cannot be recovered from the app.
            </li>
            {hadMedia ? (
              <li data-testid="delete-media-note">
                <strong className="text-amber-300/90">Its rendered frames and clips</strong> stay in
                the project folder on disk, but stop being reachable here. Recovering them means
                going to the folder.
              </li>
            ) : null}
            {cues > 0 ? (
              <li data-testid="delete-cue-note">
                {cues === 1 ? "One audio cue is" : `${cues} audio cues are`} anchored to this scene
                and {cues === 1 ? "goes" : "go"} with it.
              </li>
            ) : null}
            {followers.length ? (
              <li data-testid="delete-follower-note">
                <strong className="text-amber-300/90">Scene{" "}
                {followers.map((s) => s.sceneNumber).join(", ")}</strong> opens on a frame carried
                over from the scene before it. After this that frame comes from a different scene,
                so it will not match until re-rendered.
              </li>
            ) : null}
            {impact.wardrobe.length ? (
              <li>
                Scene {impact.wardrobe.map((s) => s.sceneNumber).join(", ")} crosses a costume
                change as a result, so the characters in it will be dressed differently.
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  );
}
