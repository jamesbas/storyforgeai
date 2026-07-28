import { SceneLoraPanel } from "@/components/storyboard/scene-lora-panel";
import type { SceneLoraOverride } from "@/lib/schemas/lora";
import type { Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import type { MediaDescriptor } from "@/lib/media/refs";

type SceneCardProps = {
  scene: Scene;
  attempt?: SceneAttempt;
  media?: MediaDescriptor[];
  busy?: boolean;
  onGenerate?: () => void;
  onApprove?: () => void;
  /**
   * LoRA wiring. Optional so the card stays renderable on its own — the panel
   * only appears when a parent supplies both the project and a save handler.
   */
  projectId?: string;
  loraOverride?: SceneLoraOverride;
  onLoraSave?: (next: SceneLoraOverride) => void;
};

/** Render a player for media that exists on disk; fall back to the path. */
function MediaTile({ descriptor }: { descriptor: MediaDescriptor }) {
  return (
    <figure className="space-y-1">
      {descriptor.kind === "video" ? (
        <video
          src={descriptor.url}
          controls
          preload="metadata"
          className="w-full rounded-md border border-white/10 bg-black"
          data-testid="scene-video-player"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={descriptor.url}
          alt={descriptor.label}
          loading="lazy"
          className="w-full rounded-md border border-white/10 bg-black object-cover"
          data-testid="scene-image-player"
        />
      )}
      <figcaption className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{descriptor.label}</span>
        <a href={descriptor.downloadUrl} className="hover:text-accent">
          Download
        </a>
      </figcaption>
    </figure>
  );
}

export function SceneCard({
  scene,
  attempt,
  media = [],
  busy = false,
  onGenerate,
  onApprove,
  projectId,
  loraOverride,
  onLoraSave,
}: SceneCardProps) {
  const playable = media.filter((m) => m.available && m.sceneId === scene.id);

  return (
    <article className="rounded-lg border border-white/10 bg-panel/40 p-4" data-testid="scene-card">
      <header className="flex items-baseline justify-between">
        <h3 className="font-semibold">
          Scene {scene.sceneNumber} — {scene.title}
        </h3>
        <span className="text-xs text-slate-500">
          {scene.startTimeSeconds}s–{scene.endTimeSeconds}s
          {scene.trimAtEndSeconds ? ` (trim ${scene.trimAtEndSeconds}s)` : ""} · {scene.status}
        </span>
      </header>
      <dl className="mt-3 space-y-1 text-sm">
        <div>
          <dt className="inline text-slate-400">Objective: </dt>
          <dd className="inline">{scene.sceneObjective}</dd>
        </div>
        <div>
          <dt className="inline text-slate-400">Visual: </dt>
          <dd className="inline">{scene.visualDescription}</dd>
        </div>
        <div>
          <dt className="inline text-slate-400">Camera: </dt>
          <dd className="inline">{scene.cameraMovement}</dd>
        </div>
      </dl>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-300">Prompts</summary>
        <div className="mt-2 space-y-2 text-slate-300">
          <p>
            <span className="text-slate-500">Start frame:</span> {scene.prompts.startFramePrompt}
          </p>
          <p>
            <span className="text-slate-500">End frame:</span> {scene.prompts.endFramePrompt}
          </p>
          <p>
            <span className="text-slate-500">Video (20s):</span> {scene.prompts.videoPromptSegment}
          </p>
        </div>
      </details>

      {projectId && onLoraSave ? (
        <SceneLoraPanel
          projectId={projectId}
          value={loraOverride}
          busy={busy}
          onSave={onLoraSave}
        />
      ) : null}

      {(onGenerate || attempt) && (
        <div className="mt-4 border-t border-white/10 pt-3" data-testid="scene-media">
          {attempt ? (
            <div className="space-y-1 text-xs text-slate-400">
              <div>
                Attempt #{attempt.attemptNumber} ·{" "}
                {attempt.approved ? (
                  <span className="text-green-300">approved</span>
                ) : (
                  <span>
                    QC {attempt.qcResult?.passed ? "passed" : "flagged"} ({attempt.qcResult?.severity})
                  </span>
                )}
              </div>
              <div className="truncate">start: {attempt.startImagePath ?? "—"}</div>
              <div className="truncate">end: {attempt.endImagePath ?? "—"}</div>
              <div className="truncate" data-testid="scene-video-path">
                video: {attempt.videoPath ?? "—"}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No media generated yet.</p>
          )}

          {playable.length > 0 && (
            <div
              className="mt-3 grid gap-3 sm:grid-cols-3"
              data-testid="scene-media-players"
            >
              {playable.map((descriptor) => (
                <MediaTile key={descriptor.assetId} descriptor={descriptor} />
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {onGenerate && (
              <button
                onClick={onGenerate}
                disabled={busy}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
              >
                {busy ? "Generating…" : attempt ? "Regenerate media" : "Generate media"}
              </button>
            )}
            {onApprove && attempt && !attempt.approved && (
              <button
                onClick={onApprove}
                disabled={busy}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
              >
                Approve attempt
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
