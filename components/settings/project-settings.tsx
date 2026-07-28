"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { WangpModel } from "@/lib/schemas/wangp";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

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
      characterWardrobe?: Record<string, string>;
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
        if (!res.ok) throw new Error("Failed to save settings");
        setRecord((await res.json()) as ProjectRecord);
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
          <p className="text-xs text-amber-300/90">
            This project pins characters from the library, so the image model must accept reference
            images (marked <span className="font-semibold">✓ refs</span>). If the pinned model cannot,
            StoryForgeAI substitutes one that can rather than dropping the characters silently.
          </p>
        ) : null}

        {saved ? <p className="text-xs text-emerald-400">Saved.</p> : null}
      </section>

      {usesCharacters ? (
        <section className="space-y-3 rounded-lg border border-white/10 bg-panel/40 p-4">
          <div>
            <h2 className="font-semibold">Wardrobe for this project</h2>
            <p className="mt-1 text-xs text-slate-500">
              Costume belongs to the story, so it is set here rather than on the character. Name
              specific garments, colours and materials — a scene&apos;s start and end frames are
              separate renders, so an unstated outfit gets reinvented and the character changes
              clothes mid-shot. Applies to scenes generated from now on.
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
