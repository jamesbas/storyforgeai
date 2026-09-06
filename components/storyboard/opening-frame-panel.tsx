"use client";

import { useState } from "react";
import type { AspectRatio } from "@/lib/types";

type OpeningFramePanelProps = {
  /** The pinned frame, when one is set. */
  pinned?: { path: string; faceSwap: boolean };
  /** Serves the pinned image so the crop can be judged before anything renders. */
  previewUrl?: string;
  /** Stated up front, since the shape is the one thing that gets changed. */
  aspectRatio?: AspectRatio;
  /** What the last upload was cropped from and to, when it was. */
  cropped?: { from: { width: number; height: number }; to: { width: number; height: number } } | null;
  busy?: boolean;
  pending?: boolean;
  /** Why the last attempt failed. Shown here, beside the control that caused it. */
  error?: string | null;
  onPin?: (file: File, faceSwap: boolean) => void;
  onUnpin?: () => void;
};

/**
 * Supply the picture scene 1 opens on, instead of rendering one.
 *
 * Separate from the per-frame import below it, which replaces a frame on an
 * attempt that already exists. This one has to be set before generation to be
 * worth anything: scene 1's end frame is rendered against it, and every later
 * scene inherits from there, so a frame arriving after the run cannot influence
 * the images it was meant to govern.
 */
export function OpeningFramePanel({
  pinned,
  previewUrl,
  aspectRatio,
  cropped,
  busy = false,
  pending = false,
  error,
  onPin,
  onUnpin,
}: OpeningFramePanelProps) {
  const [faceSwap, setFaceSwap] = useState(false);
  const disabled = busy || pending;

  return (
    <div
      className="mt-2 rounded-md border border-white/10 bg-black/20 p-2.5"
      data-testid="opening-frame"
    >
      <p className="text-[11px] text-slate-500">
        Pin the image this story opens on. It is used exactly as supplied — no start frame is
        rendered for this scene — and every later keyframe is built from it.
      </p>

      {pinned ? (
        <div className="mt-2 space-y-2" data-testid="opening-frame-pinned">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="The pinned opening frame, exactly as it will be used"
              className="w-full max-w-xs rounded-md border border-white/10 bg-black"
              data-testid="opening-frame-preview"
            />
          ) : null}
          <p className="text-[11px] text-sky-300/80">
            Opening frame pinned
            {pinned.faceSwap ? " · face swap will be applied" : " · used verbatim"}
          </p>
          {cropped ? (
            <p className="text-[11px] text-amber-200/90" data-testid="opening-frame-cropped">
              Centre-cropped from {cropped.from.width}×{cropped.from.height} to {cropped.to.width}
              ×{cropped.to.height} to match {aspectRatio}. This is the image above — check it before
              generating, and release it if the crop lost something.
            </p>
          ) : null}
          <p className="text-[10px] text-slate-500">
            Regenerating media will not touch it. Release it to go back to a rendered start frame.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={onUnpin}
            data-testid="unpin-opening-frame"
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-200 hover:border-accent/60 disabled:opacity-50"
          >
            Release pinned frame
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={faceSwap}
              disabled={disabled}
              onChange={(e) => setFaceSwap(e.target.checked)}
              data-testid="opening-frame-face-swap"
              className="h-3.5 w-3.5 accent-accent"
            />
            Apply the face swap to it
          </label>
          <p className="text-[10px] text-slate-600">
            Leave off when the image already shows the right person. Turn it on to put a pinned
            character&apos;s face onto a stand-in.
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={disabled}
            data-testid="pin-opening-frame"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so re-picking the same file fires onChange again.
              e.target.value = "";
              if (file) onPin?.(file, faceSwap);
            }}
            className="block text-[11px] text-slate-400 file:mr-2 file:rounded-md file:border file:border-white/10 file:bg-panel/60 file:px-2.5 file:py-1 file:text-[11px] file:text-slate-200 disabled:opacity-50"
          />
          <p className="text-[10px] text-slate-600">
            PNG, JPEG or WebP, up to 16 MB.
            {aspectRatio && aspectRatio !== "custom"
              ? ` Anything that is not ${aspectRatio} is centre-cropped to fit, and you will see the result here before anything renders.`
              : ""}
          </p>
        </div>
      )}

      {pending ? (
        <p className="mt-2 text-[11px] text-slate-400" data-testid="opening-frame-pending">
          Uploading…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-300" data-testid="opening-frame-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
