"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { WangpModel } from "@/lib/schemas/wangp";
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
        if (res.ok) setRecord((await res.json()) as ProjectRecord);
        await loadModels(showAll);
      } catch {
        setError("Failed to reach WanGP. Model lists are unavailable.");
      }
    })();
  }, [projectId, showAll, loadModels]);

  const save = useCallback(
    async (patch: { imageModel?: string; videoModel?: string }) => {
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

  const picker = (
    label: string,
    value: string | undefined,
    options: WangpModel[],
    total: number,
    onChange: (next: string) => void,
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

        {picker("Image model (start and end frames)", project.imageModel, imageModels, counts.image, (next) =>
          save({ imageModel: next }),
        )}
        {picker("Video model (clips)", project.videoModel, videoModels, counts.video, (next) =>
          save({ videoModel: next }),
        )}

        {saved ? <p className="text-xs text-emerald-400">Saved.</p> : null}
      </section>
    </div>
  );
}
