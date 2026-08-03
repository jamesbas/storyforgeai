import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { reconcileProject } from "@/lib/tasks/task-service";

/**
 * Reconcile every project's tasks once, at boot (SPEC-008 FR-3).
 *
 * Runs before any drainer can start, so an entry left in `submitting` by a
 * killed process is already `submission_unknown` by the time anything could
 * pick it up — the difference between a recoverable restart and a duplicate
 * GPU job.
 *
 * Discovery walks the data directory for task files rather than asking the
 * project repository, deliberately: a project whose `project.json` is corrupt
 * is exactly the case where an orphaned GPU job most needs recovering, and
 * making recovery depend on that record parsing would strand it.
 */
export async function reconcileStartup(): Promise<{
  projects: number;
  reconciling: number;
  interrupted: number;
  unknown: number;
}> {
  const totals = { projects: 0, reconciling: 0, interrupted: 0, unknown: 0 };
  const root = path.resolve(process.cwd(), config.dataDir);

  let dirs: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No data directory yet, or unreadable. Booting matters more than recovery.
    return totals;
  }

  for (const projectId of dirs) {
    try {
      await fs.access(path.join(root, projectId, "tasks.json"));
    } catch {
      continue;
    }
    try {
      const counts = await reconcileProject(projectId);
      totals.projects += 1;
      totals.reconciling += counts.reconciling;
      totals.interrupted += counts.interrupted;
      totals.unknown += counts.unknown;
    } catch {
      // One unreadable task file must not stop the others being recovered;
      // the repository has already quarantined it.
    }
  }

  if (totals.projects) logEvent("task.reconciled", { scope: "startup", ...totals });
  return totals;
}
