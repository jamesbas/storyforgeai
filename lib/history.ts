import type { ProjectRecord } from "@/lib/schemas/storyboard";

/** Timestamp of the most recent occurrence of any of these history actions. */
export function lastActionAt(record: ProjectRecord, ...actions: string[]): string | undefined {
  return (record.history ?? [])
    .filter((entry) => actions.includes(entry.action))
    .map((entry) => entry.at)
    .sort()
    .pop();
}

/**
 * Scenes hand-edited since the storyboard was last generated.
 *
 * Regenerating rewrites every prompt, so these are what a regeneration would
 * discard. Machine repairs are recorded under their own action and are
 * deliberately not counted: they rebuild what the pipeline would produce
 * anyway, so losing them costs nothing.
 */
export function handEditedSinceGeneration(record: ProjectRecord): string[] {
  const generatedAt = lastActionAt(record, "storyboard.generated");
  const edits = (record.history ?? []).filter(
    (entry) =>
      entry.action === "scene.prompts_edited" && (!generatedAt || entry.at > generatedAt),
  );
  return [...new Set(edits.map((entry) => entry.detail).filter((d): d is string => Boolean(d)))];
}
