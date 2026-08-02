"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PlanPanel } from "@/components/agentic-canvas/plan-panel";
import { useAgentRun } from "@/components/shared/use-agent-run";
import { planOn, planSpecFor } from "@/lib/agents/plan-fields";
import { isContinuousTake } from "@/lib/agents/continuity";
import { shotPlanIssues } from "@/lib/media/seam";
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

/**
 * The plans that feed the storyboard, in the order they build on one another.
 *
 * Variant Explorer is not here: choosing a direction is a human decision, and
 * running it would leave an unselected set of variants that changes nothing.
 * Storyboard Artist is not here either — it is what these plans feed, so it is
 * offered as a separate follow-on step.
 */
const CORE_AGENT_KEYS = ["world", "director", "cinematographer", "art"] as const;

export function AgenticCanvas({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set while the sequential runner is working, so single buttons stay locked. */
  const [runningAll, setRunningAll] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [alsoStoryboard, setAlsoStoryboard] = useState(true);
  const stopRequested = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.ok) setRecord((await res.json()) as ProjectRecord);
    else setError("Failed to load project");
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A run started here, or before a navigation, or in another tab.
  const { agentKey: remoteKey } = useAgentRun(projectId, () => void load());

  /** Run one agent. Returns the updated record, or null when it failed. */
  const runAgent = useCallback(
    async (agent: CanvasAgent): Promise<ProjectRecord | null> => {
      if (!agent.endpoint) return null;
      setBusyKey(agent.key);
      try {
        const res = await fetch(`/api/projects/${projectId}/${agent.endpoint}`, { method: "POST" });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Failed to run ${agent.name}`);
        }
        const next = (await res.json()) as ProjectRecord;
        setRecord(next);
        return next;
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to run ${agent.name}`);
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [projectId],
  );

  const run = useCallback(
    async (agent: CanvasAgent) => {
      setError(null);
      await runAgent(agent);
    },
    [runAgent],
  );

  /**
   * Run the plan agents in order, then optionally the storyboard.
   *
   * Strictly sequential. Each call occupies the planning model for as long as it
   * takes, and on a single GPU overlapping them is slower at best. Running in
   * dependency order also matters: the storyboard folds in whichever plans exist
   * *at the moment it runs*, so it has to come last to see them all.
   */
  const runCore = useCallback(async () => {
    setError(null);
    setRunningAll(true);
    stopRequested.current = false;

    const queue = AGENTS.filter((a) => (CORE_AGENT_KEYS as readonly string[]).includes(a.key));
    const storyboard = AGENTS.find((a) => a.key === "storyboard");
    const total = queue.length + (alsoStoryboard && storyboard ? 1 : 0);

    try {
      let done = 0;
      setProgress({ done, total });

      for (const agent of queue) {
        if (stopRequested.current) return;
        // Stop on the first failure rather than pressing on: a later plan built
        // against a missing earlier one is not what the user asked for.
        if (!(await runAgent(agent))) return;
        done += 1;
        setProgress({ done, total });
      }

      if (alsoStoryboard && storyboard && !stopRequested.current) {
        if (!(await runAgent(storyboard))) return;
        setProgress({ done: done + 1, total });
      }
    } finally {
      setRunningAll(false);
      setProgress(null);
      stopRequested.current = false;
    }
  }, [alsoStoryboard, runAgent]);

  const history = useMemo(() => record?.history ?? [], [record]);

  /**
   * Any in-flight agent locks every button.
   *
   * Previously only the clicked agent's button disabled, so four agents could be
   * started at once and collide inside a local model that serves one at a time.
   */
  const busy = runningAll || busyKey !== null || remoteKey !== null;
  /** Which card shows a spinner — this tab's run, or one recovered from the server. */
  const activeKey = busyKey ?? remoteKey;

  /** Only meaningful on a continuous take: on a cut project, varied sizes are the point. */
  const shotIssues =
    record && isContinuousTake(record.project) && record.cinematographyPlan
      ? shotPlanIssues(record.cinematographyPlan.sceneShotPlans)
      : [];

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
          <button
            type="button"
            onClick={() => void runCore()}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {runningAll && progress
              ? `Running ${progress.done + 1} of ${progress.total}…`
              : "Run core agents"}
          </button>
          {runningAll ? (
            <button
              type="button"
              onClick={() => {
                stopRequested.current = true;
              }}
              className="rounded-md border border-white/15 px-3 py-2 text-sm text-slate-300 hover:border-accent"
            >
              Stop after this one
            </button>
          ) : null}
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

      {remoteKey && !busyKey && !runningAll ? (
        <p
          data-testid="canvas-remote-run"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200/90"
        >
          {AGENTS.find((a) => a.key === remoteKey)?.name ?? "An agent"} is still running on the
          server. It was started elsewhere or before you last left this page — the buttons stay
          locked until it finishes, and the results appear here on their own.
        </p>
      ) : null}

      {record.conceptVisuals?.contradictions.length ? (
        <section
          data-testid="canvas-concept-contradictions"
          className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-200">
            Your reference images disagree with your concept
          </h2>
          <p className="text-xs text-amber-100/80">
            The concept wins. These fields are withheld from every agent below, which write them
            from your concept alone. Change the concept or the images in{" "}
            <Link href={`/settings/${projectId}`} className="underline hover:text-amber-100">
              project settings
            </Link>{" "}
            if that is not what you want.
          </p>
          <ul className="space-y-0.5 text-xs text-amber-100/90">
            {record.conceptVisuals.contradictions.map((c, index) => (
              <li key={`${c.field}-${index}`}>
                <span className="font-semibold text-amber-200">{c.field}</span>
                {c.concept ? <> — concept: {c.concept}</> : null}
                {c.image ? <> / reference: {c.image}</> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Run the crew in order
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              World Builder → Director → Cinematographer → Art Director, one at a time. The
              storyboard folds in whichever plans exist when it runs, so it goes last — running it
              first is why a plan can appear &ldquo;ready&rdquo; yet change nothing in the render.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={alsoStoryboard}
              disabled={busy}
              onChange={(e) => setAlsoStoryboard(e.target.checked)}
            />
            Generate the storyboard afterwards
          </label>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          Agent calls are queued server-side too, so nothing collides inside the planning model even
          if you start something else while this runs.
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {AGENTS.map((agent) => {
          const status = agent.status(record);
          const spec = planSpecFor(agent.key);
          const plan = spec ? planOn(record, spec) : undefined;
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
                disabled={busy}
                className="mt-3 rounded-md border border-white/10 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
              >
                {activeKey === agent.key ? "Running…" : status === "ready" ? "Regenerate" : "Generate"}
              </button>
              {/* Nothing to read until the agent has produced something. */}
              {spec && plan ? (
                <PlanPanel
                  spec={spec}
                  plan={plan}
                  projectId={projectId}
                  disabled={busy}
                  onSaved={setRecord}
                />
              ) : null}
              {agent.key === "cinematographer" && shotIssues.length ? (
                <div
                  data-testid="shot-plan-breaks"
                  className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200/90"
                >
                  <p>
                    This project is one continuous take, but the plan breaks that in{" "}
                    {shotIssues.length} place{shotIssues.length === 1 ? "" : "s"}. Each one is a cut
                    the renderer will refuse to carry a frame across.
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {shotIssues.slice(0, 4).map((issue, i) => (
                      <li key={`${issue.kind}-${issue.at}-${i}`}>
                        {issue.kind === "lens"
                          ? `Two lenses across one take (${issue.detail}) — you cannot change lens without stopping the camera.`
                          : issue.kind === "height"
                            ? `Camera height moves between ${issue.detail} without a crane or boom to carry it.`
                            : issue.kind === "move"
                              ? `Segment ${issue.at} ${issue.detail}.`
                              : `Segment ${issue.at} ${issue.detail}.`}
                      </li>
                    ))}
                    {shotIssues.length > 4 ? <li>and {shotIssues.length - 4} more.</li> : null}
                  </ul>
                  <p className="mt-1">Regenerate, or edit the plan above to match.</p>
                </div>
              ) : null}
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
