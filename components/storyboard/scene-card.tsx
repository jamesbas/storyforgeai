import { SceneLoraPanel } from "@/components/storyboard/scene-lora-panel";
import { ScenePromptsPanel } from "@/components/storyboard/scene-prompts-panel";
import { SceneCardEditor } from "@/components/storyboard/scene-card-editor";
import { SceneWardrobePanel } from "@/components/storyboard/scene-wardrobe-panel";
import type { SceneLoraOverride } from "@/lib/schemas/lora";
import type { Character } from "@/lib/schemas/character";
import type { WardrobeChange } from "@/lib/schemas/wardrobe";
import type { Scene } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
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
   * LoRA and prompt-editing wiring. Optional so the card stays renderable on its
   * own — the panels only appear when a parent supplies the project context.
   */
  projectId?: string;
  loraOverride?: SceneLoraOverride;
  onLoraSave?: (next: SceneLoraOverride) => void;
  /** Trigger words appended automatically at generation, by prompt kind. */
  triggerWords?: { image: string[]; video: string[] };
  onPromptsSaved?: (record: ProjectRecord) => void;
  /** The project's pinned cast, for the wardrobe panel. Empty hides it. */
  cast?: readonly Character[];
  /** Costume changes already set at this scene. */
  wardrobeChanges?: readonly WardrobeChange[];
  continuousTake?: boolean;
  /** Render a single keyframe without the other frame or the clip. */
  onGenerateKeyframe?: (purpose: "start_frame" | "end_frame") => void;
  /** Discard this scene's previews once they have been looked at. */
  onClearPreviews?: () => void;
  /** The scene's pinned image seed, once one has been minted. */
  seed?: number;
  /** Re-roll the pinned seed so the next render samples afresh. */
  onNewSeed?: () => void;
  /** Correct the planner when a shot's framing was called wrong. */
  onFaceVisibleChange?: (next: boolean) => void;
  /** Apply the face swap to one already-rendered frame. */
  onSwapFace?: (purpose: "start_frame" | "end_frame") => void;
  /** Discard a swap, restoring the frame as it was rendered. */
  onRevertFace?: (purpose: "start_frame" | "end_frame") => void;
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
  triggerWords,
  onPromptsSaved,
  cast = [],
  wardrobeChanges = [],
  continuousTake = false,
  onGenerateKeyframe,
  onClearPreviews,
  seed,
  onNewSeed,
  onFaceVisibleChange,
  onSwapFace,
  onRevertFace,
}: SceneCardProps) {
  const playable = media.filter((m) => m.available && m.sceneId === scene.id);
  const hasPreviews = playable.some((m) => m.preview);

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
      {onFaceVisibleChange ? (
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={scene.subjectFaceVisible !== false}
            disabled={busy}
            onChange={(e) => onFaceVisibleChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-white/20 bg-canvas accent-accent"
            data-testid="scene-face-visible"
          />
          <span>
            Face in frame
            <span className="ml-1 text-slate-500">
              — off skips the face swap, which otherwise grafts a head onto shots that have none
            </span>
          </span>
        </label>
      ) : null}
      {projectId ? (
        <SceneCardEditor
          scene={scene}
          projectId={projectId}
          busy={busy}
          onSaved={onPromptsSaved}
        />
      ) : null}
      {projectId ? (
        <ScenePromptsPanel
          scene={scene}
          projectId={projectId}
          triggerWords={triggerWords}
          busy={busy}
          onSaved={onPromptsSaved}
        />
      ) : (
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
              <span className="text-slate-500">Video:</span> {scene.prompts.videoPromptSegment}
            </p>
          </div>
        </details>
      )}
      {projectId ? (
        <SceneWardrobePanel
          scene={scene}
          projectId={projectId}
          cast={cast}
          changes={wardrobeChanges}
          continuousTake={continuousTake}
          busy={busy}
          onSaved={onPromptsSaved}
        />
      ) : null}

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
                ) : attempt.qcResult ? (
                  <span>
                    QC {attempt.qcResult.passed ? "passed" : "flagged"} ({attempt.qcResult.severity})
                  </span>
                ) : (
                  <span className="text-slate-500">not graded</span>
                )}
              </div>
              {attempt.qcResult && !attempt.qcResult.passed ? (
                <div
                  className="rounded-md border border-amber-400/25 bg-amber-400/5 p-2 text-amber-200/90"
                  data-testid="scene-qc-issues"
                >
                  <ul className="list-disc space-y-0.5 pl-4">
                    {attempt.qcResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                  {attempt.qcResult.regenerationInstructions ? (
                    <p className="mt-1.5 border-t border-amber-400/20 pt-1.5 text-amber-200/70">
                      {attempt.qcResult.regenerationInstructions}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="truncate">start: {attempt.startImagePath ?? "—"}</div>
              {attempt.startImageInherited && (
                <p
                  data-testid="scene-inherited-start"
                  className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-200/80"
                >
                  Start frame carried over from the previous scene, so this scene&apos;s start-frame
                  prompt was not rendered. Switch Scene continuity to &ldquo;Cut between
                  scenes&rdquo; if this scene is a separate shot.
                </p>
              )}
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

          {onGenerateKeyframe && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-500">Preview one frame:</span>
              <button
                onClick={() => onGenerateKeyframe("start_frame")}
                disabled={busy}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:border-accent disabled:opacity-50"
              >
                Start frame only
              </button>
              <button
                onClick={() => onGenerateKeyframe("end_frame")}
                disabled={busy}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:border-accent disabled:opacity-50"
              >
                End frame only
              </button>
              {hasPreviews && onClearPreviews && (
                <button
                  onClick={onClearPreviews}
                  disabled={busy}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:border-accent disabled:opacity-50"
                  data-testid="clear-previews"
                >
                  Remove previews
                </button>
              )}
              <span className="text-[10px] text-slate-600">
                One image, no clip — for checking a prompt, model or LoRA change cheaply. Previews
                are not part of an attempt and are never assembled.
              </span>
            </div>
          )}

          {onSwapFace && attempt && (attempt.startImagePath || attempt.endImagePath) && (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="manual-face-swap">
              <span className="text-[11px] text-slate-500">Swap face on:</span>
              {(
                [
                  ["start_frame", "Start", attempt.startImagePath, attempt.startImageSourcePath],
                  ["end_frame", "End", attempt.endImagePath, attempt.endImageSourcePath],
                ] as const
              ).map(([purpose, label, path, source]) => (
                <span key={purpose} className="flex items-center gap-1">
                  <button
                    onClick={() => onSwapFace(purpose)}
                    disabled={busy || !path}
                    title={source ? "Re-runs the swap from the original render" : undefined}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:border-accent disabled:opacity-50"
                  >
                    {label} frame{source ? " ✓" : ""}
                  </button>
                  {source && onRevertFace ? (
                    <button
                      onClick={() => onRevertFace(purpose)}
                      disabled={busy}
                      title="Put back the frame as it was rendered"
                      className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400 hover:border-accent disabled:opacity-50"
                    >
                      undo
                    </button>
                  ) : null}
                </span>
              ))}
              <span className="text-[10px] text-slate-600">
                For a shot the plan called faceless that came back with a face. A ✓ means the frame
                is already swapped; re-running works from the original render, not the swap.
              </span>
              {attempt.videoPath ? (
                <p className="w-full text-[10px] text-amber-300/80">
                  This attempt already has a clip, and it was built from the current frames —
                  regenerate the media to make the video match a swapped frame.
                </p>
              ) : null}
            </div>
          )}

          {onNewSeed && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-500">
                Seed: {seed === undefined ? "not set — minted on first render" : seed}
              </span>
              <button
                onClick={onNewSeed}
                disabled={busy || seed === undefined}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:border-accent disabled:opacity-50"
                data-testid="new-seed"
              >
                New seed
              </button>
              <span className="text-[10px] text-slate-600">
                Pinned so a preview predicts the keyframe. Regenerating reproduces the same image —
                take a new seed to get a different one.
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
