"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SceneCard } from "@/components/storyboard/scene-card";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { MediaDescriptor } from "@/lib/media/refs";

export function StoryboardView({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [media, setMedia] = useState<MediaDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMedia = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/media`);
    if (res.ok) {
      const data = (await res.json()) as { media: MediaDescriptor[] };
      setMedia(data.media);
    }
  }, [projectId]);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.status === 404) {
      setError("Project not found");
      setRecord(null);
    } else if (res.ok) {
      setRecord((await res.json()) as ProjectRecord);
      await loadMedia();
    } else {
      setError("Failed to load project");
    }
    setLoading(false);
  }, [projectId, loadMedia]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-storyboard`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to generate storyboard");
      setRecord((await res.json()) as ProjectRecord);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate storyboard");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const [sceneBusy, setSceneBusy] = useState<string | null>(null);

  const generateSceneMedia = useCallback(
    async (sceneId: string) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/generate`, {
          method: "POST",
        });
        if (!res.ok) throw new Error("Failed to generate scene media");
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate scene media");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia],
  );

  const approveScene = useCallback(
    async (sceneId: string, attemptId: string) => {
      setSceneBusy(sceneId);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/scenes/${sceneId}/approve-attempt/${attemptId}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error("Failed to approve attempt");
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to approve attempt");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia],
  );

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>;
  if (error && !record) return <p role="alert" className="text-sm text-red-300">{error}</p>;
  if (!record) return null;

  const { project, storyboard } = record;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{project.title}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {project.segmentCount} scenes · {project.generatedDurationSeconds}s generated ·{" "}
            {project.finalTrimSeconds}s trim · {project.status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/variant-review/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Variant review
          </Link>
          <Link
            href={`/agentic-canvas/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Agentic canvas
          </Link>
          <Link
            href={`/generation-console/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Generation console
          </Link>
          <Link
            href={`/assembly/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Assembly
          </Link>
          <Link
            href={`/settings/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Settings
          </Link>
          <button
            onClick={generate}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Generating…" : storyboard ? "Regenerate storyboard" : "Generate storyboard"}
          </button>
          {storyboard && (
            <>
              <a
                href={`/api/projects/${projectId}/export?format=json`}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                Export JSON
              </a>
              <a
                href={`/api/projects/${projectId}/export?format=md`}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                Export MD
              </a>
            </>
          )}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {storyboard ? (
        <>
          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Logline</h2>
            <p className="mt-1">{storyboard.brief.logline}</p>
            <p className="mt-2 text-sm text-slate-400">{storyboard.brief.synopsis}</p>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Scenes</h2>
            {storyboard.scenes.map((scene) => {
              const attempts = record.attempts?.[scene.id] ?? [];
              const latest = attempts[attempts.length - 1];
              return (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  attempt={latest}
                  media={media}
                  busy={sceneBusy === scene.id}
                  onGenerate={() => generateSceneMedia(scene.id)}
                  onApprove={latest ? () => approveScene(scene.id, latest.id) : undefined}
                />
              );
            })}
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-400">
          No storyboard yet. Generate one to plan {project.segmentCount} scenes.
        </p>
      )}
    </div>
  );
}
