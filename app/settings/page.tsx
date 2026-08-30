"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { CharacterLibrary } from "@/components/settings/character-library";
import { GenerationDefaults } from "@/components/settings/generation-defaults";
import { SystemPromptSettingsForm } from "@/components/settings/system-prompt-settings";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { Project } from "@/lib/schemas/project";

/**
 * Global settings, reachable from anywhere.
 *
 * Per-project model pins still live on the project settings screen because they
 * only make sense against a specific project; everything that is genuinely
 * app-wide — the character library — lives here so it can be curated before any
 * project exists.
 */
export default function SettingsPage() {
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/projects");
      const data = res.ok ? ((await res.json()) as { projects: Project[] }) : null;
      if (isCurrent() && data) setProjects(data.projects);
    } catch {
      // non-fatal: the character library does not depend on projects
    }
  }, []);

  useLoadEffect(load);

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">
            App-wide configuration. Available at any time, with or without an open project.
          </p>
        </header>

        <CharacterLibrary />

        <SystemPromptSettingsForm />

        <GenerationDefaults />

        <CollapsibleSection
          testId="per-project-models-section"
          title="Per-project generation models"
          description="Each project keeps its own pins, starting from the defaults above and free to differ. The right model often depends on the aspect ratio, clip length and look of that specific piece. Pick a project to edit its pins."
        >
          <ul className="space-y-2">
            {projects.length === 0 ? (
              <li className="text-sm text-slate-500">No projects yet.</li>
            ) : null}
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/settings/${project.id}`}
                  className="block rounded-md border border-white/10 bg-canvas/40 px-3 py-2 text-sm hover:border-accent"
                >
                  <span className="block truncate font-medium">{project.title}</span>
                  <span className="text-xs text-slate-500">
                    {project.segmentCount} scenes · image {project.imageModel ?? "auto"} · video{" "}
                    {project.videoModel ?? "auto"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      </div>
    </AppShell>
  );
}
