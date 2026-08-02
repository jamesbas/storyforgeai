"use client";

import Link from "next/link";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Tells the user which creative plans are actually reaching the render.
 *
 * The canvas plans are folded into the storyboard *at the moment it is
 * generated* — their content is baked into each scene's prompts, and nothing
 * reads the plans again at media time. So a plan generated after the storyboard
 * has no effect at all until the storyboard is regenerated.
 *
 * That is invisible in the UI otherwise: the canvas shows every plan as "ready"
 * whether or not the storyboard ever saw it. Comparing generation timestamps is
 * what turns a silent no-op into something the user can act on.
 */

const PLANS = [
  {
    key: "worldBible",
    action: "world_bible.generated",
    editedAction: "world_bible.edited",
    label: "World Builder",
    effect: "Visual motifs, and forbidden contradictions as negative prompts",
  },
  {
    key: "directorialPlan",
    action: "directorial_plan.generated",
    editedAction: "directorial_plan.edited",
    label: "Director",
    effect: "Per-scene intent, applied to that scene's prompts only",
  },
  {
    key: "cinematographyPlan",
    action: "cinematography_plan.generated",
    editedAction: "cinematography_plan.edited",
    label: "Cinematographer",
    effect: "Per-scene shot plan, plus lens, movement and lighting rules",
  },
  {
    key: "artDirectionPlan",
    action: "art_direction_plan.generated",
    editedAction: "art_direction_plan.edited",
    label: "Art Director",
    effect: "Production design, wardrobe, props and set dressing",
  },
] as const;

/**
 * `ready` and `stale` both mean "not in a storyboard", and conflating them read
 * as an alarm on a project that had done nothing wrong: every plan freshly
 * generated, no storyboard yet, and four amber "not applied yet" badges saying
 * so. Waiting for a first storyboard is the normal state of a correct project.
 */
type PlanState = "applied" | "ready" | "stale" | "missing";

/** Timestamp of the most recent occurrence of any of these history actions. */
function lastAt(record: ProjectRecord, ...actions: string[]): string | undefined {
  return (record.history ?? [])
    .filter((entry) => actions.includes(entry.action))
    .map((entry) => entry.at)
    .sort()
    .pop();
}

type PlanStatus = { label: string; effect: string; state: PlanState };

export function planStates(record: ProjectRecord): {
  states: PlanStatus[];
  staleCount: number;
  missingCount: number;
} {
  const storyboardAt = lastAt(record, "storyboard.generated");

  const states: PlanStatus[] = PLANS.map((plan) => {
    const exists = Boolean(record[plan.key]);
    if (!exists) return { label: plan.label, effect: plan.effect, state: "missing" };
    // Nothing to be out of step with until a storyboard exists.
    if (!storyboardAt) return { label: plan.label, effect: plan.effect, state: "ready" };

    // Without history we cannot prove staleness, so assume the plan applies
    // rather than raising a false alarm. An edit counts the same as a
    // regeneration: both change what the storyboard would have folded in.
    const planAt = lastAt(record, plan.action, plan.editedAction);
    const stale = Boolean(planAt && planAt > storyboardAt);
    return { label: plan.label, effect: plan.effect, state: stale ? "stale" : "applied" };
  });

  return {
    states,
    staleCount: states.filter((s) => s.state === "stale").length,
    missingCount: states.filter((s) => s.state === "missing").length,
  };
}

const BADGE: Record<PlanState, { text: string; className: string }> = {
  applied: { text: "in this storyboard", className: "bg-emerald-500/15 text-emerald-300" },
  ready: { text: "ready to apply", className: "bg-sky-500/15 text-sky-300" },
  stale: { text: "not applied yet", className: "bg-amber-500/15 text-amber-300" },
  missing: { text: "not generated", className: "bg-white/5 text-slate-500" },
};

export function CreativePlansPanel({
  record,
  projectId,
  busy,
  onRegenerate,
}: {
  record: ProjectRecord;
  projectId: string;
  busy: boolean;
  onRegenerate: () => void;
}) {
  const { states, staleCount, missingCount } = planStates(record);
  const hasStoryboard = Boolean(record.storyboard);

  return (
    <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Creative plans
        </h2>
        <Link
          href={`/agentic-canvas/${projectId}`}
          className="text-xs text-accent hover:underline"
        >
          Open the Agentic canvas →
        </Link>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        These plans are folded into the storyboard when it is generated, and baked into each
        scene&apos;s prompts. Nothing reads them again during image or video generation — so a plan
        only reaches a render if it existed when the storyboard was written.
      </p>

      <ul className="mt-3 space-y-1.5">
        {states.map((plan) => (
          <li key={plan.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="text-sm text-slate-200">{plan.label}</span>
              <span className="block text-[11px] text-slate-500">{plan.effect}</span>
            </div>
            <span
              className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${BADGE[plan.state].className}`}
            >
              {BADGE[plan.state].text}
            </span>
          </li>
        ))}
      </ul>

      {hasStoryboard && staleCount > 0 ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-200">
            <strong>
              {staleCount} plan{staleCount === 1 ? "" : "s"} changed after this storyboard was
              written.
            </strong>{" "}
            Until you regenerate, none of that direction reaches the images or video. Scene ids are
            stable, so regenerating keeps your existing media, attempts and LoRA choices.
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            className="mt-2 rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Regenerating…" : "Regenerate storyboard to apply"}
          </button>
        </div>
      ) : null}

      {!hasStoryboard && missingCount > 0 ? (
        <p className="mt-3 rounded-md border border-white/10 bg-canvas/60 p-3 text-xs text-slate-400">
          You can generate a storyboard without these, but running them first is the single biggest
          quality lever in the app. Order matters: run the plans on the Agentic canvas, then
          generate the storyboard last so it picks them all up.
        </p>
      ) : null}

      {!hasStoryboard && missingCount === 0 ? (
        <p className="mt-3 rounded-md border border-sky-500/25 bg-sky-500/5 p-3 text-xs text-sky-200/80">
          All four plans are written and waiting. Generating the storyboard now folds every one of
          them into the scene prompts — which is the order that gets them into your renders.
        </p>
      ) : null}

      {hasStoryboard && staleCount === 0 && missingCount > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          {missingCount} plan{missingCount === 1 ? " has" : "s have"} never been generated. Running{" "}
          {missingCount === 1 ? "it" : "them"} and regenerating the storyboard usually improves
          consistency across scenes.
        </p>
      ) : null}

      <p className="mt-3 text-[11px] text-slate-600">
        The Audio Director and Animatic do not affect image or video generation. To confirm what a
        plan actually contributed, expand <strong>Prompts</strong> on any scene below — that text is
        exactly what is sent to WanGP.
      </p>
    </section>
  );
}
