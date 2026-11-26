import type { RunType, ScheduleItem, ItemState } from "@/lib/schemas/schedule";
import { RUN_TYPE_LABELS } from "@/lib/schemas/schedule";
import type { GenerationMode } from "@/lib/types";
import { generationStages } from "@/lib/types";

/**
 * The add form's rules, kept out of the component so they can be read — and
 * tested — on their own. The server enforces the same rules; this only stops
 * the form offering what would be refused.
 */

export type ProjectOption = {
  id: string;
  title: string;
  generationMode: GenerationMode;
  hasStoryboard: boolean;
  sceneCount: number;
};

export type Availability = { enabled: boolean; reason?: string };

export const RUN_TYPE_OPTIONS: { value: RunType; label: string }[] = [
  { value: "storyboard", label: "Storyboard (Agentic Canvas)" },
  { value: "keyframes", label: "Keyframes generation" },
  { value: "video", label: "Video generation" },
];

export const GENERATION_MODE_LABELS: Record<GenerationMode, string> = {
  storyboard_only: "Storyboard only",
  keyframes_only: "Keyframes only",
  video_segments: "Video segments",
  full_auto: "Full auto",
};

/** A storyboard item for this project that has not finished yet sits ahead. */
export function storyboardAhead(earlier: readonly ScheduleItem[], projectId: string): boolean {
  return earlier.some(
    (item) =>
      item.projectId === projectId &&
      item.runType === "storyboard" &&
      (item.state === "queued" || item.state === "running"),
  );
}

export function runTypeAvailability(
  project: ProjectOption,
  earlier: readonly ScheduleItem[],
  durableTasks: boolean,
): Record<RunType, Availability> {
  const stages = generationStages(project.generationMode);
  const storyboardComing = project.hasStoryboard || storyboardAhead(earlier, project.id);
  const noStoryboard = "This project has no storyboard yet. Add a Storyboard item for it first.";
  const mode = GENERATION_MODE_LABELS[project.generationMode];

  const keyframes: Availability = !stages.keyframes
    ? { enabled: false, reason: `${mode} mode renders no keyframes.` }
    : durableTasks
      ? { enabled: false, reason: "Keyframe-only runs are not available with durable tasks yet." }
      : !storyboardComing
        ? { enabled: false, reason: noStoryboard }
        : { enabled: true };

  const video: Availability = !stages.video
    ? { enabled: false, reason: `${mode} mode renders no clips.` }
    : !storyboardComing
      ? { enabled: false, reason: noStoryboard }
      : { enabled: true };

  return { storyboard: { enabled: true }, keyframes, video };
}

/** FR-6: picked scenes would describe a storyboard that an earlier item replaces. */
export function selectedScenesAvailability(
  project: ProjectOption,
  earlier: readonly ScheduleItem[],
): Availability {
  if (storyboardAhead(earlier, project.id)) {
    return {
      enabled: false,
      reason: "A Storyboard item for this project runs first and replaces its scenes, so only All scenes is offered here.",
    };
  }
  if (!project.hasStoryboard) {
    return { enabled: false, reason: "This project has no storyboard yet, so there are no scenes to pick." };
  }
  return { enabled: true };
}

export function scopeText(item: Pick<ScheduleItem, "runType" | "scope">): string | null {
  if (item.runType === "storyboard") return null;
  if (item.scope.mode === "all") return "All scenes";
  const numbers = item.scope.sceneNumbers.length ? item.scope.sceneNumbers : item.scope.sceneIds;
  return `Scene${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
}

export function optionsText(item: Pick<ScheduleItem, "runType" | "scope" | "options">): string | null {
  if (item.runType === "keyframes" && item.scope.mode === "all") {
    return item.options.keyframes === "rerender" ? "Re-render every scene" : "Only scenes without keyframes";
  }
  if (item.runType === "video") return item.options.redoFinished ? "Redo finished scenes" : null;
  return null;
}

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  queued: "Queued",
  invalid: "Invalid",
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function itemTitle(item: Pick<ScheduleItem, "runType" | "projectTitle">): string {
  return `${RUN_TYPE_LABELS[item.runType]} — ${item.projectTitle}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function secondsBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const span = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(span) ? span : null;
}

/** Where an item's work shows up: the canvas for plans, the storyboard for media. */
export function projectHref(item: Pick<ScheduleItem, "runType" | "projectId">): string {
  return item.runType === "storyboard"
    ? `/agentic-canvas/${item.projectId}`
    : `/storyboard/${item.projectId}`;
}
