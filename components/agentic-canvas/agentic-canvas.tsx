"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

type CanvasAgent = {
  key: string;
  name: string;
  role: string;
  endpoint: string | null;
  status: (r: ProjectRecord) => "ready" | "empty" | "external";
  summary: (r: ProjectRecord) => string;
};

const AGENTS: CanvasAgent[] = [
  {
    key: "variants",
    name: "Variant Explorer",
    role: "Creative directions",
    endpoint: "generate-variants",
    status: (r) => (r.variants && r.variants.length > 0 ? "ready" : "empty"),
    summary: (r) => (r.variants?.length ? `${r.variants.length} directions` : "Not generated"),
  },
  {
    key: "world",
    name: "World Builder",
    role: "World bible",
    endpoint: "generate-world-bible",
    status: (r) => (r.worldBible ? "ready" : "empty"),
    summary: (r) => r.worldBible?.premise ?? "Not generated",
  },
  {
    key: "director",
    name: "Director",
    role: "Directorial plan",
    endpoint: "generate-directorial-plan",
    status: (r) => (r.directorialPlan ? "ready" : "empty"),
    summary: (r) => r.directorialPlan?.creativeThesis ?? "Not generated",
  },
  {
    key: "cinematographer",
    name: "Cinematographer",
    role: "Camera plan",
    endpoint: "generate-cinematography-plan",
    status: (r) => (r.cinematographyPlan ? "ready" : "empty"),
    summary: (r) => r.cinematographyPlan?.cameraLanguage ?? "Not generated",
  },
  {
    key: "art",
    name: "Art Director",
    role: "Art direction",
    endpoint: "generate-art-direction-plan",
    status: (r) => (r.artDirectionPlan ? "ready" : "empty"),
    summary: (r) => r.artDirectionPlan?.productionDesign ?? "Not generated",
  },
  {
    key: "storyboard",
    name: "Storyboard Artist",
    role: "Scene cards",
    endpoint: "generate-storyboard",
    status: (r) => (r.storyboard ? "ready" : "empty"),
    summary: (r) => (r.storyboard ? `${r.storyboard.scenes.length} scenes` : "Not generated"),
  },
  {
    key: "audio",
    name: "Audio Director",
    role: "Audio plan",
    endpoint: "generate-audio-plan",
    status: (r) => (r.audioPlan ? "ready" : "empty"),
    summary: (r) =>
      r.audioPlan
        ? `${r.audioPlan.sceneAudioCues.length} cues, ${r.audioPlan.voiceProfiles.length} voices`
        : "Not generated",
  },
  {
    key: "animatic",
    name: "Animatic",
    role: "Previsualization",
    endpoint: "generate-animatic",
    status: (r) => (r.animaticPlan ? "ready" : "empty"),
    summary: (r) =>
      r.animaticPlan ? `${r.animaticPlan.frames.length} frames` : "Needs a storyboard first",
  },
];

export function AgenticCanvas({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.ok) setRecord((await res.json()) as ProjectRecord);
    else setError("Failed to load project");
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (agent: CanvasAgent) => {
      if (!agent.endpoint) return;
      setBusyKey(agent.key);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/${agent.endpoint}`, { method: "POST" });
        if (!res.ok) throw new Error(`Failed to run ${agent.name}`);
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusyKey(null);
      }
    },
    [projectId],
  );

  const history = useMemo(() => record?.history ?? [], [record]);

  if (!record) {
    return <p className="text-sm text-slate-400">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Agentic canvas</h1>
          <p className="mt-1 text-sm text-slate-400">
            Your creative team for <span className="text-slate-200">{record.project.title}</span>.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/variant-review/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Variant review
          </Link>
          <Link
            href={`/animatic/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Animatic
          </Link>
          <Link
            href={`/storyboard/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Storyboard
          </Link>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {AGENTS.map((agent) => {
          const status = agent.status(record);
          return (
            <article
              key={agent.key}
              data-testid="agent-card"
              className="rounded-lg border border-white/10 bg-panel/40 p-4"
            >
              <header className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{agent.name}</h3>
                  <p className="text-xs text-slate-500">{agent.role}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    status === "ready" ? "bg-green-500/20 text-green-300" : "bg-white/10 text-slate-400"
                  }`}
                >
                  {status === "ready" ? "ready" : "pending"}
                </span>
              </header>
              <p className="mt-2 line-clamp-2 text-sm text-slate-300">{agent.summary(record)}</p>
              <button
                onClick={() => run(agent)}
                disabled={busyKey === agent.key}
                className="mt-3 rounded-md border border-white/10 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
              >
                {busyKey === agent.key ? "Running…" : status === "ready" ? "Regenerate" : "Generate"}
              </button>
            </article>
          );
        })}
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Decision history
        </h2>
        <ul className="mt-2 space-y-1 text-xs text-slate-400">
          {history.length === 0 && <li>No activity yet.</li>}
          {history.map((h, i) => (
            <li key={i}>
              <span className="text-slate-500">{h.at.slice(11, 19)}</span> · {h.action}
              {h.detail ? ` — ${h.detail}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
