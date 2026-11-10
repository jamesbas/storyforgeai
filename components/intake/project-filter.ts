import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";

export type ProjectStatusFilter = ProjectStatus | "all";

/** "needs_review" → "Needs review". */
export function projectStatusLabel(status: ProjectStatus): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How many projects sit in each status, every status present even at zero. */
export function countByStatus(projects: readonly Project[]): Record<ProjectStatus, number> {
  const counts = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, 0])) as Record<
    ProjectStatus,
    number
  >;
  for (const project of projects) counts[project.status] += 1;
  return counts;
}

/** Narrows by status, then by a case-insensitive match on title or concept. */
export function filterProjects(
  projects: readonly Project[],
  query: string,
  status: ProjectStatusFilter,
): readonly Project[] {
  const needle = query.trim().toLowerCase();
  if (!needle && status === "all") return projects;
  return projects.filter(
    (project) =>
      (status === "all" || project.status === status) &&
      (!needle ||
        project.title.toLowerCase().includes(needle) ||
        project.concept.toLowerCase().includes(needle)),
  );
}
