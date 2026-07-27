"use client";

import { useCallback, useState } from "react";
import type { AudioCue } from "@/lib/schemas/audio";
import type { MediaDescriptor } from "@/lib/media/refs";

type SceneLabel = { id: string; sceneNumber: number; durationSeconds: number };

type AudioCuePanelProps = {
  projectId: string;
  cues: AudioCue[];
  scenes: SceneLabel[];
  media: MediaDescriptor[];
  onChanged: () => Promise<void> | void;
};

/**
 * Music/SFX cue review.
 *
 * Dialogue is rendered by the video model from the scene prompt, so nothing
 * here deals with speech. These cues are the beds StoryForge generates and
 * mixes over the cut at assembly.
 */
export function AudioCuePanel({ projectId, cues, scenes, media, onChanged }: AudioCuePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (cueId: string, body: Record<string, unknown>, method: "POST" | "PATCH" = "POST") => {
      setBusy(cueId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/audio-cues/${cueId}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Cue action failed");
        }
        await onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Cue action failed");
      } finally {
        setBusy(null);
      }
    },
    [projectId, onChanged],
  );

  if (!cues.length) {
    return (
      <p className="text-sm text-slate-400">
        No music or SFX cues. Generate an audio plan to have the Audio Director propose some.
      </p>
    );
  }

  const sceneNumberFor = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.sceneNumber ?? "?";

  return (
    <div className="space-y-3" data-testid="audio-cue-panel">
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {cues.map((cue) => {
          const audio = media.find((m) => m.cueId === cue.id && m.available);
          const isBusy = busy === cue.id;
          return (
            <li
              key={cue.id}
              className="rounded-md border border-white/10 bg-panel/40 p-3"
              data-testid="audio-cue"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">
                  {cue.kind === "music" ? "Music" : "SFX"} · Scene {sceneNumberFor(cue.sceneId)}
                </span>
                <span className="text-xs text-slate-500">
                  +{cue.startSeconds}s for {cue.durationSeconds}s · {cue.gainDb} dB
                  {cue.duckNativeDb < 0 ? ` · ducks clip ${cue.duckNativeDb} dB` : " · additive"}
                  {cue.approved ? " · " : ""}
                  {cue.approved && <span className="text-green-300">approved</span>}
                </span>
              </div>

              <p className="mt-1 text-xs text-slate-400">{cue.prompt}</p>

              {audio && (
                <audio
                  src={audio.url}
                  controls
                  preload="metadata"
                  className="mt-2 w-full"
                  data-testid="audio-cue-player"
                />
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => act(cue.id, { action: "generate" })}
                  disabled={isBusy}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
                >
                  {isBusy ? "Working…" : cue.generatedPath ? "Regenerate" : "Generate"}
                </button>
                {cue.generatedPath && (
                  <button
                    onClick={() => act(cue.id, { action: cue.approved ? "unapprove" : "approve" })}
                    disabled={isBusy}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
                  >
                    {cue.approved ? "Unapprove" : "Approve"}
                  </button>
                )}
                <button
                  onClick={() =>
                    act(cue.id, { duckNativeDb: cue.duckNativeDb < 0 ? 0 : -12 }, "PATCH")
                  }
                  disabled={isBusy}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
                  title="Toggle between ducking the clip's own audio and mixing on top of it"
                >
                  {cue.duckNativeDb < 0 ? "Stop ducking" : "Duck clip audio"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-slate-500">
        Approved cues are mixed into the final cut on the next assembly.
      </p>
    </div>
  );
}
