"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LoraSelector } from "@/components/settings/lora-selector";
import { ConceptImages } from "@/components/settings/concept-images";
import type { LoraSelectionSet } from "@/lib/schemas/lora";
import type { WangpModel } from "@/lib/schemas/wangp";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ResolutionPreset } from "@/lib/types";
import { RESOLUTION_PRESETS } from "@/lib/types";
import { RESOLUTION_DOCS } from "@/lib/presets";
import { resolveResolution } from "@/lib/wangp/resolution";

type ModelsResponse = { models: WangpModel[]; total: number };

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
      imageSteps?: number | null;
      videoSteps?: number | null;
      resolutionPreset?: ResolutionPreset;
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

  const picker = (
    label: string,
    value: string | undefined,
    options: WangpModel[],
    total: number,
    onChange: (next: string) => void,
    /** Annotate reference-image support (image models only). */
    showReferenceSupport = false,
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
      <span className="text-[11px] text-slate-500">
        {options.length} of {total} shown
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
        <Link href={`/storyboard/${projectId}`} className="text-sm text-accent hover:underline">
          Back to storyboard
        </Link>
      </header>

      <p className="text-xs text-slate-500">
        Looking for the character library?{" "}
        <Link href="/settings" className="text-accent hover:underline">
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

        {picker(
          "Image model (start and end frames)",
          project.imageModel,
          imageModels,
          counts.image,
          (next) => save({ imageModel: next }),
          true,
        )}
        {picker("Video model (clips)", project.videoModel, videoModels, counts.video, (next) =>
          save({ videoModel: next }),
        )}

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

        <div className="space-y-2 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold">Resolution</h3>
          <p className="text-xs text-slate-500">
            Sets the frame size and the floor on automatic steps. The shape comes from the
            project&apos;s {project.aspectRatio} aspect ratio, so only the quality changes here.
            Existing media is left alone — re-render a scene to pick up a new size.
          </p>
          <div className="flex flex-wrap gap-2">
            {RESOLUTION_PRESETS.map((preset) => {
              const active = project.resolutionPreset === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  title={RESOLUTION_DOCS[preset]}
                  onClick={() => {
                    if (!active) void save({ resolutionPreset: preset });
                  }}
                  className={`rounded-md border px-3 py-1.5 text-xs capitalize disabled:opacity-50 ${
                    active
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-white/10 text-slate-400 hover:border-white/25"
                  }`}
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
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Save wardrobe
          </button>
        </section>
      ) : null}
    </div>
  );
}
