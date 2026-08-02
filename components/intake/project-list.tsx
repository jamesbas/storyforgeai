"use client";

import { useCallback, useState } from "react";
import { ProjectListItem } from "@/components/intake/project-list-item";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { Project } from "@/lib/schemas/project";

/**
 * The project list, shared by the landing page and the Projects screen.
 *
 * Ordered newest-touched first rather than by creation: a project is worth
 * returning to because you were working on it, and the API returns whatever
 * order the store happens to hold.
 */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { projects: Project[] };
      if (isCurrent()) {
        setProjects([...data.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
    } catch {
      // non-fatal in demo mode
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useLoadEffect(reload);

  const forget = useCallback((id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
  }, []);

  return { projects, loading, forget, reload };
}

export function ProjectList({
  projects,
  onDeleted,
  onChanged,
  className = "space-y-2",
}: {
  projects: readonly Project[];
  onDeleted: (id: string) => void;
  onChanged?: () => void;
  className?: string;
}) {
  return (
    <ul className={className}>
      {projects.map((project) => (
        <ProjectListItem
          key={project.id}
          project={project}
          onDeleted={() => onDeleted(project.id)}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}
