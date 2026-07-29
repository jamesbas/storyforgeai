"use client";

import { useCallback, useEffect, useState } from "react";
import { ProjectListItem } from "@/components/intake/project-list-item";
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

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok || !live) return;
        const data = (await res.json()) as { projects: Project[] };
        setProjects([...data.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      } catch {
        // non-fatal in demo mode
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const forget = useCallback((id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
  }, []);

  return { projects, loading, forget };
}

export function ProjectList({
  projects,
  onDeleted,
  className = "space-y-2",
}: {
  projects: readonly Project[];
  onDeleted: (id: string) => void;
  className?: string;
}) {
  return (
    <ul className={className}>
      {projects.map((project) => (
        <ProjectListItem
          key={project.id}
          project={project}
          onDeleted={() => onDeleted(project.id)}
        />
      ))}
    </ul>
  );
}
