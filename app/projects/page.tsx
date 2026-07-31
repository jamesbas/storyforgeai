"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { ImportProject } from "@/components/intake/import-project";
import { ProjectList, useProjects } from "@/components/intake/project-list";

export default function ProjectsPage() {
  const { projects, loading, forget, reload } = useProjects();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) =>
        project.title.toLowerCase().includes(needle) ||
        project.concept.toLowerCase().includes(needle),
    );
  }, [projects, query]);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Projects</h1>
            <p className="mt-1 text-sm text-slate-400">
              Every storyboard on this machine. Open one to pick up where you left off.
            </p>
          </div>
          <Link
            href="/projects/new"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80"
          >
            New project
          </Link>
        </header>

        <ImportProject onImported={() => void reload()} />

        {projects.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="project-search" className="sr-only">
              Search projects
            </label>
            <input
              id="project-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title or concept"
              className="w-full max-w-sm rounded-md border border-white/10 bg-panel/40 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-accent focus:outline-none"
            />
            <span className="text-xs text-slate-500">
              {filtered.length} of {projects.length}
            </span>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-slate-500">Loading projects…</p>
        ) : projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/15 bg-panel/20 p-10 text-center">
            <h2 className="font-semibold">No projects yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
              A project starts with a concept and a target duration. StoryForgeAI plans the brief,
              visual style and scene cards from there.
            </p>
            <Link
              href="/projects/new"
              className="mt-4 inline-block rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80"
            >
              Create your first project
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-500">No project matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <ProjectList
            projects={filtered}
            onDeleted={forget}
            onChanged={() => void reload()}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          />
        )}
      </div>
    </AppShell>
  );
}
