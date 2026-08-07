"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LoraSelector } from "@/components/settings/lora-selector";
import { ConceptImages } from "@/components/settings/concept-images";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { LoraSelectionSet } from "@/lib/schemas/lora";
import type { WangpModel } from "@/lib/schemas/wangp";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ResolutionPreset } from "@/lib/types";
import { MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, RESOLUTION_PRESETS } from "@/lib/types";
import { RESOLUTION_DOCS } from "@/lib/presets";
import { clampPreset, resolveResolution, videoResolutionCeiling } from "@/lib/wangp/resolution";
import { clipLengthGuidance } from "@/lib/wangp/clip-length";
import {
  ESTIMATE_HARDWARE,
  FL2VA_ESTIMATE_MINUTES,
  ref2vaEstimateMinutes,
} from "@/lib/wangp/render-estimate";
import { familyOf, isMinimaxFamily, type ModelFamily } from "@/lib/wangp/family";

type ModelsResponse = { models: WangpModel[]; total: number };

/** What a job would actually run on, and whether WanGP is answering. */
type ModelChoice = {
  status: { enabled: boolean; mode: "mock" | "live"; url: string; ok: boolean };
  image: { modelType: string; name: string } | null;
  video: { modelType: string; name: string } | null;
};

/**
 * Per-project settings.
 *
 * Model pins only affect future generations, so they stay editable for the life
 * of the project. The lists default to installed models only: WanGP accepts a
 * job for a model it does not have and silently downloads the weights first.
 */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [imageModels, setImageModels] = useState<WangpModel[]>([]);
  const [videoModels, setVideoModels] = useState<WangpModel[]>([]);
  const [counts, setCounts] = useState({ image: 0, video: 0 });
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [cast, setCast] = useState<Character[]>([]);
  const [wardrobe, setWardrobe] = useState<Record<string, string>>({});
  const [loras, setLoras] = useState<LoraSelectionSet>({ image: [], video: [] });
  const [clipSeconds, setClipSeconds] = useState<number | null>(null);
  const [confirmClip, setConfirmClip] = useState(false);
  const [choice, setChoice] = useState<ModelChoice | null>(null);

  const loadModels = useCallback(async (all: boolean) => {
    const suffix = all ? "" : "&installed=1";
    const [img, vid] = await Promise.all([
      fetch(`/api/wangp/models?output=image${suffix}`).then((r) =>
        r.ok ? (r.json() as Promise<ModelsResponse>) : null,
      ),
      fetch(`/api/wangp/models?output=video${suffix}`).then((r) =>
        r.ok ? (r.json() as Promise<ModelsResponse>) : null,
      ),
    ]);
    setImageModels(img?.models ?? []);
    setVideoModels(vid?.models ?? []);
    setCounts({ image: img?.total ?? 0, video: vid?.total ?? 0 });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (res.ok) {
          const next = (await res.json()) as ProjectRecord;
          setRecord(next);
          setWardrobe(next.project.characterWardrobe ?? {});
          setLoras(next.project.loras ?? { image: [], video: [] });
        }
        await loadModels(showAll);
      } catch {
        setError("Failed to reach WanGP. Model lists are unavailable.");
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/model-choice`);
        if (res.ok) setChoice((await res.json()) as ModelChoice);
      } catch {
        // Advisory only: the pickers still work without knowing the default.
      }
    })();
  }, [projectId, showAll, loadModels]);

  // Only the characters this project pinned are worth showing here.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/characters");
        if (res.ok) setCast(((await res.json()) as { characters: Character[] }).characters);
      } catch {
        // The library is optional; model pins still work without it.
      }
    })();
  }, []);

  const save = useCallback(
    async (patch: {
      imageModel?: string;
      videoModel?: string;
      videoTier?: "fl2va" | "ref2va";
      imageSteps?: number | null;
      videoSteps?: number | null;
      resolutionPreset?: ResolutionPreset;
      videoResolutionPreset?: ResolutionPreset;
      segmentSeconds?: number;
      qcEnabled?: boolean;
      characterWardrobe?: Record<string, string>;
      useCharacterReferenceImages?: boolean;
      loras?: LoraSelectionSet;
    }) => {
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        const res = await fetch(`/api/projects/${projectId}/models`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? "Failed to save settings");
        }
        const next = (await res.json()) as ProjectRecord;
        setRecord(next);
        setLoras(next.project.loras ?? { image: [], video: [] });
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  if (!record) {
    return <p className="text-sm text-slate-400">Loading settings…</p>;
  }

  const { project } = record;
  const usesCharacters = Boolean(project.useCharacterLibrary && project.characterIds?.length);

  // Guidance is keyed on the pinned video model. An unpinned project gets none,
  // deliberately: advice written for one model and applied to another is worse
  // than silence.
  const videoFamily = familyOf(
    project.videoModel,
    videoModels.find((m) => m.modelType === project.videoModel)?.metadata.family,
  );
  const videoCeiling = videoResolutionCeiling(videoFamily);
  const clipAdvice = clipLengthGuidance(videoFamily);

  // The tier is offered only where a checkpoint exists to serve it, and only
  // where WanGP says the weights are actually present: an unavailable model
  // renders nothing until it has downloaded tens of gigabytes (FR-10).
  const h3Of = (family: ModelFamily) =>
    videoModels.find(
      (m) =>
        familyOf(m.modelType, m.metadata.family) === family &&
        (m.metadata.availability ?? "available") === "available",
    );
  const h3Fl2va = h3Of("minimax");
  const h3Ref2va = h3Of("minimax_ref2va");
  // Scene casts vary; the project's opted-in cast is the only count available
  // here, held at the per-scene cap so the estimate cannot promise less than
  // the renderer will refuse.
  const castSize = Math.min(usesCharacters ? project.characterIds?.length ?? 1 : 1, 3);

  const wangpReachable = choice ? choice.status.ok : undefined;
  const videoPreset = project.videoResolutionPreset ?? project.resolutionPreset;
  const pendingClip = clipSeconds ?? project.segmentSeconds;

  const picker = (
    label: string,
    value: string | undefined,
    options: WangpModel[],
    total: number,
    onChange: (next: string) => void,
    /** Annotate reference-image support (image models only). */
    showReferenceSupport = false,
    /** What this picker resolves to when left on Automatic. */
    resolved?: { modelType: string; name: string } | null,
  ) => (
    <label className="block space-y-1">
      <span className="text-sm text-slate-300">{label}</span>
      <select
        className="w-full rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm"
        value={value ?? ""}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Automatic (best ranked)</option>
        {options.map((m) => (
          <option key={m.modelType} value={m.modelType}>
            {m.name} — {m.modelType}
            {showReferenceSupport && m.metadata.mediaInputs?.image?.reference ? " ✓ refs" : ""}
            {m.metadata.availability && m.metadata.availability !== "available"
              ? ` (${m.metadata.availability})`
              : ""}
          </option>
        ))}
      </select>
      {!value && resolved ? (
        <span className="block text-[11px] text-slate-400">
          Currently renders on <strong className="text-slate-200">{resolved.name}</strong> —{" "}
          <code>{resolved.modelType}</code>
        </span>
      ) : null}
      <span className="text-[11px] text-slate-500">
        {total === 0
          ? wangpReachable === false
            ? "WanGP is not answering, so no models can be listed."
            : "WanGP reported no models of this kind."
          : `${options.length} of ${total} shown`}
        {value && !options.some((m) => m.modelType === value)
          ? ` · current pin "${value}" is not in this list`
          : ""}
      </span>
    </label>
  );

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Settings — {project.title}</h1>
          <p className="text-sm text-slate-400">
            {project.segmentCount} scenes · {project.segmentSeconds}s per clip ·{" "}
            {project.generatedDurationSeconds}s generated
          </p>
        </div>
        <Link href={`/storyboard/${projectId}`} className="text-sm text-accent underline underline-offset-2">
          Back to storyboard
        </Link>
      </header>

      <p className="text-xs text-slate-500">
        Looking for the character library?{" "}
        <Link href="/settings" className="text-accent underline underline-offset-2">
          Global settings
        </Link>{" "}
        holds the configuration shared by every project.
      </p>

      {error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <ConceptImages
        projectId={projectId}
        initial={project.conceptImages ?? []}
        initialVisuals={record.conceptVisuals}
        initialFidelity={record.conceptFidelity}
      />

      <section className="space-y-4 rounded-lg border border-white/10 bg-panel/40 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Generation models</h2>
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show models that are not installed
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Uninstalled models still work, but WanGP downloads the weights before rendering —
          often tens of gigabytes, with no progress shown here.
        </p>

        {wangpReachable === false ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            WanGP is not answering at <code>{choice?.status.url}</code>, so no models can be listed
            and nothing will render. Your existing pins are kept — start WanGP and reload this page.
          </p>
        ) : null}

        {picker(
          "Image model (start and end frames)",
          project.imageModel,
          imageModels,
          counts.image,
          (next) => save({ imageModel: next }),
          true,
          choice?.image,
        )}
        {picker(
          "Video model (clips)",
          project.videoModel,
          videoModels,
          counts.video,
          (next) => save({ videoModel: next }),
          false,
          choice?.video,
        )}

        {isMinimaxFamily(videoFamily) && (h3Fl2va || h3Ref2va) ? (
          <div className="space-y-2 rounded-md border border-white/10 bg-canvas/40 p-3">
            <h4 className="text-sm font-semibold">How MiniMax H3 is given the shot</h4>
            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="video-tier"
                className="mt-0.5 accent-accent"
                disabled={busy || !h3Fl2va}
                checked={project.videoTier !== "ref2va"}
                onChange={() => save({ videoTier: "fl2va", videoModel: h3Fl2va?.modelType })}
              />
              <span>
                <strong>First and last frame</strong> — about {FL2VA_ESTIMATE_MINUTES} min per clip.
                The two keyframes are pinned to the opening and closing moments and the model
                generates the path between them.
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="video-tier"
                className="mt-0.5 accent-accent"
                disabled={busy || !h3Ref2va}
                checked={project.videoTier === "ref2va"}
                onChange={() => save({ videoTier: "ref2va", videoModel: h3Ref2va?.modelType })}
              />
              <span>
                <strong>Reference mode</strong> — about {ref2vaEstimateMinutes(castSize)} min per
                clip with {castSize === 1 ? "1 character" : `${castSize} characters`}{" "}
                in the scene. Holds each pinned character&apos;s face for the whole clip, not just
                at its two ends. Costs roughly 5 more minutes per character, and clips are capped
                at {clipLengthGuidance("minimax_ref2va")?.recommendedSeconds}s.
                {h3Ref2va ? "" : " No reference-mode checkpoint is installed."}
              </span>
            </label>
            <p className="text-[11px] text-slate-500">
              Times measured on {ESTIMATE_HARDWARE} at 848×480. Yours will differ — the ratio
              between the two is the part that travels.
            </p>
          </div>
        ) : null}

        {usesCharacters ? (
          <div className="space-y-2 rounded-md border border-white/10 bg-canvas/40 p-3">
            <h4 className="text-sm font-semibold">How a character&apos;s likeness reaches the frame</h4>
            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="character-references"
                className="mt-0.5 accent-accent"
                disabled={busy}
                checked={project.useCharacterReferenceImages !== false}
                onChange={() => save({ useCharacterReferenceImages: true })}
              />
              <span>
                <strong>Reference photograph</strong> — strongest likeness.
                <span className="block text-slate-500">
                  The photo conditions the whole frame rather than one figure in it, so on a shot
                  with several people the model can apply the likeness to more than one of them. The
                  image model must accept reference images (marked{" "}
                  <span className="font-semibold">✓ refs</span>); if the pinned one cannot,
                  StoryForgeAI substitutes one that can rather than dropping the characters silently.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="character-references"
                className="mt-0.5 accent-accent"
                disabled={busy}
                checked={project.useCharacterReferenceImages === false}
                onChange={() => save({ useCharacterReferenceImages: false })}
              />
              <span>
                <strong>Description and face swap only</strong> — no photograph is sent.
                <span className="block text-slate-500">
                  Nothing bleeds onto other people in the shot, and any image model can be used. The
                  likeness comes from the written description and is corrected afterwards by the face
                  swap, so it needs a character with face swap enabled to hold up.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <div className="space-y-3 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold">Resolution</h3>
          <p className="text-xs text-slate-500">
            Sets the frame size and the floor on automatic steps. The shape comes from the
            project&apos;s {project.aspectRatio} aspect ratio, so only the quality changes here.
            Keyframes and clips are set separately because a heavy video model can make a large
            clip impractical without there being any reason to render the keyframes small — and the
            keyframes are what fix identity, wardrobe and set. Existing media is left alone —
            re-render a scene to pick up a new size.
          </p>

          {(
            [
              ["Keyframes", project.resolutionPreset, undefined] as const,
              ["Clips", videoPreset, videoCeiling] as const,
            ]
          ).map(([label, current, ceiling]) => (
            <div key={label} className="space-y-1">
              <span className="text-xs text-slate-400">{label}</span>
              <div className="flex flex-wrap gap-2">
                {RESOLUTION_PRESETS.map((preset) => {
                  const active = current === preset;
                  const held = clampPreset(preset, ceiling) !== preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      disabled={busy}
                      title={held ? `${RESOLUTION_DOCS[preset]} — held down for this model` : RESOLUTION_DOCS[preset]}
                      onClick={() => {
                        if (active) return;
                        void save(
                          label === "Keyframes"
                            ? { resolutionPreset: preset }
                            : { videoResolutionPreset: preset },
                        );
                      }}
                      className={`rounded-md border px-3 py-1.5 text-xs capitalize disabled:opacity-50 ${
                        active
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-white/10 text-slate-400 hover:border-white/25"
                      } ${held ? "line-through decoration-slate-500" : ""}`}
                    >
                      {preset}
                      <span className="ml-2 font-mono text-[10px] text-slate-500">
                        {resolveResolution({
                          aspectRatio: project.aspectRatio,
                          preset,
                          fallback: "model default",
                        })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {videoCeiling ? (
            <p className="text-xs text-slate-400" data-testid="video-resolution-ceiling">
              This video model is held at <strong>{videoCeiling}</strong> for clips however this is
              set: it is slow enough at larger sizes that its own developers recommend rendering
              small and upscaling afterwards, which is what happens here.
            </p>
          ) : null}
        </div>

        <div className="space-y-2 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold">Clip length</h3>
          <p className="text-xs text-slate-500">
            How long each scene&apos;s clip runs. The scene count does not change, so making clips
            shorter makes the whole piece shorter. Only affects clips rendered from here on.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              aria-label="Clip length in seconds"
              min={MIN_SEGMENT_SECONDS}
              max={MAX_SEGMENT_SECONDS}
              value={pendingClip}
              disabled={busy}
              onChange={(e) => setClipSeconds(Number(e.target.value))}
              className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs"
            />
            <span className="text-xs text-slate-500">
              seconds · {MIN_SEGMENT_SECONDS}–{MAX_SEGMENT_SECONDS}
            </span>
            <button
              type="button"
              disabled={busy || pendingClip === project.segmentSeconds}
              onClick={() => setConfirmClip(true)}
              className="rounded-md border border-white/15 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-accent disabled:opacity-50"
            >
              Change clip length
            </button>
          </div>
          {clipAdvice ? (
            <p className="text-xs text-slate-400" data-testid="clip-length-advice">
              This model renders up to {clipAdvice.singleWindowSeconds}s in one pass. Longer clips
              are stitched together from overlapping passes inside WanGP, where StoryForgeAI can
              neither tune the join nor see that it happened —{" "}
              <strong>{clipAdvice.recommendedSeconds}s</strong> is recommended so every seam is one
              you control between scenes.
            </p>
          ) : null}
        </div>

        <ConfirmDialog
          open={confirmClip}
          title="Change clip length?"
          confirmLabel={`Use ${pendingClip}s clips`}
          busy={busy}
          busyLabel="Saving…"
          onCancel={() => setConfirmClip(false)}
          onConfirm={() => {
            setConfirmClip(false);
            void save({ segmentSeconds: pendingClip });
          }}
        >
          <p>
            Every one of this project&apos;s {project.segmentCount} scenes will be retimed from{" "}
            {project.segmentSeconds}s to {pendingClip}s, taking the finished piece from{" "}
            {project.segmentCount * project.segmentSeconds}s to{" "}
            {project.segmentCount * pendingClip}s.
          </p>
          <p className="mt-2">
            The storyboard is not re-planned and no scene is added or removed. Clips already
            rendered keep their current length until you render them again.
          </p>
        </ConfirmDialog>

        <div className="space-y-2 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold">Denoising steps</h3>
          <p className="text-xs text-slate-500">
            Leave blank to decide automatically. WanGP reports whatever was last set in its own UI
            as a model&apos;s default, so a model last used with a Lightning LoRA comes back asking
            for 4 steps — and StoryForgeAI replaces the LoRA stack on every job, which would strip
            the accelerator but keep its step count. Automatic reads the step count from an
            accelerator LoRA&apos;s name when it has one (<code>Lightning-8steps</code> → 8), leaves
            a distilled model&apos;s own count alone, and otherwise holds a floor so an
            unaccelerated model is never run at a Lightning step count.
          </p>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ["Image steps", project.imageSteps, (v: number | null) => save({ imageSteps: v })],
                ["Video steps", project.videoSteps, (v: number | null) => save({ videoSteps: v })],
              ] as const
            ).map(([label, value, onSave]) => (
              <label key={label} className="text-xs text-slate-400">
                <span className="block">{label}</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  defaultValue={value ?? ""}
                  placeholder="auto"
                  disabled={busy}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const next = raw === "" ? null : Number(raw);
                    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 200)) return;
                    if ((value ?? null) !== next) void onSave(next);
                  }}
                  className="mt-1 w-28 rounded-md border border-white/10 bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2 border-t border-white/10 pt-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(project.qcEnabled)}
              disabled={busy}
              onChange={(e) => void save({ qcEnabled: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-white/20 bg-canvas accent-accent"
            />
            <span>
              <span className="block text-sm font-semibold">Grade scenes with the QC agent</span>
              <span className="mt-1 block text-xs text-slate-500">
                Off by default. QC is a full LLM round-trip per scene once rendering finishes, on
                the same GPU that just did the work — minutes of extra runtime for a batch.
              </span>
            </span>
          </label>
          {project.qcEnabled ? (
            <p className="text-xs text-amber-300/90">
              Set <code>OPENAI_VISION_MODEL</code> for QC to judge the rendered frames. Without it
              it reviews prompt text only and cannot comment on how anything looks.
            </p>
          ) : null}
        </div>

        {saved ? <p className="text-xs text-emerald-400">Saved.</p> : null}
      </section>

      <section className="space-y-4 rounded-lg border border-white/10 bg-panel/40 p-4">
        <div>
          <h2 className="font-semibold">LoRAs for this storyboard</h2>
          <p className="mt-1 text-xs text-slate-500">
            Applied to every scene unless a scene overrides them. The lists are filtered to the
            LoRAs installed for the model pinned above, so changing a model can drop selections
            that do not exist for the new one.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Some LoRAs do nothing unless a trigger word appears in the prompt. Where one is known
            it is shown beneath the LoRA — add it to your concept or scene prompts.
          </p>
        </div>

        <div className="space-y-1">
          <span className="text-sm text-slate-300">Image LoRAs (start and end frames)</span>
          <LoraSelector
            projectId={projectId}
            kind="image"
            modelType={project.imageModel}
            value={loras.image}
            disabled={busy}
            onChange={(next) => setLoras((current) => ({ ...current, image: next }))}
          />
        </div>

        <div className="space-y-1">
          <span className="text-sm text-slate-300">Video LoRAs (clips)</span>
          {videoFamily === "minimax_ref2va" && loras.video.length ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Reference mode takes no LoRAs, so every clip will fail until these are cleared. The
              checkpoint declares no LoRA field at all, and accelerators are worse than useless
              here — a 4-step LoRA finished in a quarter of the time and scattered the referenced
              face across several people, which is the one thing this mode exists to prevent.
            </p>
          ) : null}
          <LoraSelector
            projectId={projectId}
            kind="video"
            modelType={project.videoModel}
            value={loras.video}
            disabled={busy}
            onChange={(next) => setLoras((current) => ({ ...current, video: next }))}
          />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void save({ loras })}
          className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save LoRAs
        </button>
      </section>

      {usesCharacters ? (
        <section className="space-y-3 rounded-lg border border-white/10 bg-panel/40 p-4">
          <div>
            <h2 className="font-semibold">Starting wardrobe for this project</h2>
            <p className="mt-1 text-xs text-slate-500">
              Costume belongs to the story, so it is set here rather than on the character. Name
              specific garments, colours and materials — a scene&apos;s start and end frames are
              separate renders, so an unstated outfit gets reinvented and the character changes
              clothes mid-shot. Applies to scenes generated from now on.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              This is what they wear at the top of the piece. To change clothes partway through, use{" "}
              <strong>Wardrobe change</strong> on the scene card where it happens.
            </p>
          </div>
          {cast
            .filter((character) => project.characterIds?.includes(character.id))
            .map((character) => (
              <label key={character.id} className="block space-y-1">
                <span className="text-sm text-slate-300">{character.name}</span>
                <input
                  maxLength={500}
                  disabled={busy}
                  value={wardrobe[character.id] ?? ""}
                  onChange={(e) =>
                    setWardrobe((current) => ({ ...current, [character.id]: e.target.value }))
                  }
                  placeholder={
                    character.wardrobe
                      ? `Library default: ${character.wardrobe}`
                      : `What ${character.name} wears in this story`
                  }
                  className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </label>
            ))}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void save({
                characterWardrobe: Object.fromEntries(
                  Object.entries(wardrobe).filter(([, value]) => value.trim() !== ""),
                ),
              })
            }
            className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Save wardrobe
          </button>
        </section>
      ) : null}
    </div>
  );
}
