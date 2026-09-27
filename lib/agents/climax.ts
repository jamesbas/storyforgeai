import type { StoryPlan } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";

/**
 * What the user has said about the climax, if anything.
 *
 * `description` names the event; `aftermath` is how many scenes follow it.
 * Either may be absent, and the arc falls back to its own judgement for that
 * half. Kept apart from the agent so the canvas can read it in the browser.
 */
export type ClimaxPlan = { description?: string; aftermath?: number };

type ClimaxSettings = Pick<Project, "climax" | "aftermathScenes">;

export function climaxPlanOf(project: ClimaxSettings): ClimaxPlan {
  const description = project.climax?.trim();
  return {
    ...(description ? { description } : {}),
    ...(project.aftermathScenes !== undefined ? { aftermath: project.aftermathScenes } : {}),
  };
}

/**
 * The climax settings an arc was written to, so the canvas can tell when the
 * user has changed them since. Recorded even when both are unset: "no climax
 * chosen" is a setting too, and an arc written before one was chosen is out of
 * date the moment it is.
 */
export function writtenAgainstOf(
  project: ClimaxSettings,
): NonNullable<StoryPlan["writtenAgainst"]> {
  const { description, aftermath } = climaxPlanOf(project);
  return {
    ...(description !== undefined ? { climax: description } : {}),
    ...(aftermath !== undefined ? { aftermathScenes: aftermath } : {}),
  };
}

/**
 * Whether the project's climax settings differ from the ones the arc was
 * written to. An arc from before the settings existed has no record, and only
 * counts as stale once the user has actually set something.
 */
export function arcPredatesClimax(
  project: ClimaxSettings,
  plan: Pick<StoryPlan, "writtenAgainst"> | undefined,
): boolean {
  if (!plan) return false;
  const now = writtenAgainstOf(project);
  const then = plan.writtenAgainst ?? {};
  return now.climax !== then.climax || now.aftermathScenes !== then.aftermathScenes;
}
