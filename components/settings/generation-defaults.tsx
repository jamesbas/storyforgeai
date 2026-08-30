"use client";

import { useCallback, useState } from "react";
import { LoraSelector } from "@/components/settings/lora-selector";
import { AsyncStatus } from "@/components/shared/async-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { GenerationDefaults } from "@/lib/schemas/generation-defaults";
import type { LoraSelectionSet } from "@/lib/schemas/lora";
import type { WangpModel } from "@/lib/schemas/wangp";

type ModelsResponse = { models: WangpModel[]; total: number };

const field =
  "w-full rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent";
const label = "text-xs font-semibold uppercase tracking-wide text-slate-400";

/**
 * The models and LoRAs a new project starts from.
 *
 * Read once when a project is created and copied onto it. Nothing here reaches
 * back into a project that already exists — a storyboard part-way through a
 * render must not have its pins changed underneath it — so these are a starting
 * point rather than a policy.
 */
export function GenerationDefaults() {
  const [defaults, setDefaults] = useState<GenerationDefaults | null>(null);
  const [loras, setLoras] = useState<LoraSelectionSet>({ image: [], video: [] });
  const [imageModels, setImageModels] = useState<WangpModel[]>([]);
  const [videoModels, setVideoModels] = useState<WangpModel[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const loadModels = useCallback(async (all: boolean) => {
    const suffix = all ? "" : "&installed=1";
    const get = (output: "image" | "video") =>
      fetch(`/api/wangp/models?output=${output}${suffix}`, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<ModelsResponse>) : null,
      );
    // One catalogue backs both lists, so the second request is sent after the
    // first rather than racing it into a second walk of the same models.
    const img = await get("image");
    const vid = await get("video");
    setImageModels(img?.models ?? []);
    setVideoModels(vid?.models ?? []);
  }, []);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const res = await fetch("/api/settings/generation-defaults", { cache: "no-store" });
        if (!res.ok) throw new Error("Could not load the defaults");
        const body = (await res.json()) as { defaults: GenerationDefaults };
        if (isCurrent()) {
          setDefaults(body.defaults);
          setLoras(body.defaults.loras);
        }
      } catch (e) {
        if (isCurrent()) {
          setFailed(true);
          setStatus(e instanceof Error ? e.message : "Could not load the defaults");
        }
      }
      await loadModels(false);
    },
    [loadModels],
  );

  useLoadEffect(load);

  const save = useCallback(
    async (patch: Partial<GenerationDefaults>) => {
      setBusy(true);
      setFailed(false);
      setStatus("Saving\u2026");
      try {
        const res = await fetch("/api/settings/generation-defaults", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Could not save the defaults");
        }
        const body = (await res.json()) as { defaults: GenerationDefaults };
        setDefaults(body.defaults);
        setLoras(body.defaults.loras);
        setStatus("Saved. New projects will start from this.");
      } catch (e) {
        setFailed(true);
        setStatus(e instanceof Error ? e.message : "Could not save the defaults");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!defaults) {
    return (
      <CollapsibleSection testId="generation-defaults-section" title="Default models & LoRAs">
        <AsyncStatus testId="generation-defaults-status" message={status} failed={failed} busy />
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      testId="generation-defaults-section"
      title="Default models & LoRAs"
      description="What a newly created project starts from, so a LoRA stack is built once rather than for every project. Existing projects are never changed by this — they own their own pins, and each can still be set differently under Project → Settings. A LoRA that the project's model does not have is dropped when the project is created, since a catalogue belongs to one model family."
    >

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => {
            setShowAll(e.target.checked);
            void loadModels(e.target.checked);
          }}
        />
        Show models that are not installed
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModelField
          id="default-image-model"
          title="Image model"
          models={imageModels}
          value={defaults.imageModel}
          disabled={busy}
          onChange={(next) => void save({ imageModel: next })}
        />
        <ModelField
          id="default-video-model"
          title="Video model"
          models={videoModels}
          value={defaults.videoModel}
          disabled={busy}
          onChange={(next) => void save({ videoModel: next })}
        />
        <StepsField
          id="default-image-steps"
          title="Image steps"
          value={defaults.imageSteps}
          disabled={busy}
          onChange={(next) => void save({ imageSteps: next })}
        />
        <StepsField
          id="default-video-steps"
          title="Video steps"
          value={defaults.videoSteps}
          disabled={busy}
          onChange={(next) => void save({ videoSteps: next })}
        />
      </div>

      <div className="space-y-4 border-t border-white/10 pt-4">
        <p className="text-xs text-slate-500">
          LoRAs are listed for the models pinned above, so changing one can drop selections that do
          not exist for the new model.
        </p>
        <div className="space-y-2">
          <span className="text-sm text-slate-300">Image LoRAs (start and end frames)</span>
          <LoraSelector
            kind="image"
            modelType={defaults.imageModel}
            value={loras.image}
            disabled={busy}
            onChange={(next) => setLoras((current) => ({ ...current, image: next }))}
          />
        </div>
        <div className="space-y-2">
          <span className="text-sm text-slate-300">Video LoRAs (clips)</span>
          <LoraSelector
            kind="video"
            modelType={defaults.videoModel}
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
          Save default LoRAs
        </button>
      </div>

      <AsyncStatus testId="generation-defaults-status" message={status} failed={failed} busy={busy} />
    </CollapsibleSection>
  );
}

function ModelField({
  id,
  title,
  models,
  value,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  models: WangpModel[];
  value?: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
      </label>
      <select
        id={id}
        data-testid={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${field}`}
      >
        <option value="">No default — chosen per project</option>
        {models.map((model) => (
          <option key={model.modelType} value={model.modelType}>
            {model.name} ({model.modelType})
          </option>
        ))}
      </select>
    </div>
  );
}

function StepsField({
  id,
  title,
  value,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  value?: number;
  disabled: boolean;
  onChange: (next: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value ? String(value) : "");
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
      </label>
      <input
        id={id}
        data-testid={id}
        type="number"
        min={1}
        max={200}
        value={draft}
        disabled={disabled}
        placeholder="Model default"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(Number(draft) || undefined)}
        className={`mt-1 ${field}`}
      />
    </div>
  );
}
