"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { NewProjectForm } from "@/components/intake/new-project-form";
import type { CreateProjectInput } from "@/lib/schemas/intake";
import type { Project } from "@/lib/schemas/project";

export default function HomePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = (await res.json()) as { projects: Project[] };
        setProjects(data.projects);
      }
    } catch {
      // non-fatal in demo mode
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleSubmit = useCallback(
    async (values: CreateProjectInput) => {
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Failed to create project");
        }
        const data = (await res.json()) as { project: Project };
        router.push(`/storyboard/${data.project.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create project");
        setSubmitting(false);
      }
    },
    [router],
  );

  return (
    <AppShell>
      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        {/*
          Grid items default to `min-width: auto`, so a wide child can push the
          column past its track size and shove the sidebar off screen. `min-w-0`
          lets the column shrink and keeps the sidebar reachable.
        */}
        <section className="min-w-0">
          <h1 className="text-2xl font-semibold">New project</h1>
          <p className="mt-1 text-sm text-slate-400">
            Describe a concept and target duration. StoryForgeAI plans a storyboard in
            equal-length segments of 5 to 20 seconds.
          </p>
          {error && (
            <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          <div className="mt-6 rounded-lg border border-white/10 bg-panel/40 p-6">
            <NewProjectForm onSubmit={handleSubmit} submitting={submitting} />
          </div>
        </section>

        <aside>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Recent projects
          </h2>
          <ul className="mt-3 space-y-2">
            {projects.length === 0 && <li className="text-sm text-slate-500">No projects yet.</li>}
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/storyboard/${p.id}`}
                  className="block rounded-md border border-white/10 bg-panel/40 px-3 py-2 text-sm hover:border-accent"
                >
                  <span className="block truncate font-medium">{p.title}</span>
                  <span className="text-xs text-slate-500">
                    {p.segmentCount} scenes · {p.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </AppShell>
  );
}
