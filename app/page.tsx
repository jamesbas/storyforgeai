"use client";

import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { ProjectList, useProjects } from "@/components/intake/project-list";

/** The pipeline in the order you meet it, so the home page sets expectations. */
const STAGES = [
  {
    title: "Describe",
    body: "Give a concept, a duration and a look. The intake agent turns it into a creative brief and story arc.",
  },
  {
    title: "Plan",
    body: "A visual bible fixes the style, cast and locations, then the storyboard agent writes scene cards with image and video prompts.",
  },
  {
    title: "Generate",
    body: "WanGP renders start and end keyframes plus a clip per scene on your own GPU. QC scores each attempt; you approve the keepers.",
  },
  {
    title: "Assemble",
    body: "Approved clips are cut together with audio into a rough cut, then exported as a package.",
  },
];

const RECENT_LIMIT = 4;

export default function HomePage() {
  const { projects, loading, forget, reload } = useProjects();
  const recent = projects.slice(0, RECENT_LIMIT);

  return (
    <AppShell>
      <div className="space-y-12">
        <section className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">
            Local-first agentic creative studio
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">
            Plan a film, then generate it.
          </h1>
          <p className="mt-4 text-slate-300">
            StoryForgeAI turns a one-line concept into a full production plan — brief, story arc,
            visual bible and scene-by-scene storyboard — then drives a local WanGP install to render
            each scene. Nothing leaves your machine, and you review every step before it costs GPU
            time.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/projects/new"
              className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80"
            >
              Start a new project
            </Link>
            <Link
              href="/projects"
              className="rounded-md border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-accent"
            >
              Browse projects
            </Link>
            <Link
              href="/help"
              className="rounded-md px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white"
            >
              Read the guide
            </Link>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            How it works
          </h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STAGES.map((stage, index) => (
              <li key={stage.title} className="rounded-lg border border-white/10 bg-panel/40 p-4">
                <span className="text-xs font-semibold text-accent">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-1 font-semibold">{stage.title}</h3>
                <p className="mt-1 text-sm text-slate-400">{stage.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Continue where you left off
            </h2>
            {projects.length > RECENT_LIMIT && (
              <Link href="/projects" className="text-xs text-accent underline underline-offset-2">
                View all {projects.length} projects
              </Link>
            )}
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-slate-500">Loading projects…</p>
          ) : recent.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              No projects yet.{" "}
              <Link href="/projects/new" className="text-accent underline underline-offset-2">
                Create your first one
              </Link>
              .
            </p>
          ) : (
            <ProjectList
              projects={recent}
              onDeleted={forget}
              onChanged={() => void reload()}
              className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            />
          )}
        </section>
      </div>
    </AppShell>
  );
}
