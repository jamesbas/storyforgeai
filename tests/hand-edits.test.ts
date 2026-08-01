import { describe, it, expect } from "vitest";
import { handEditedSinceGeneration, lastActionAt } from "@/lib/history";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * What a regeneration would discard.
 *
 * Regenerating rewrites every prompt. Someone who has spent an hour working
 * through eighteen scene cards deserves to be told that before it happens
 * rather than after.
 */

function record(history: { at: string; action: string; detail?: string }[]): ProjectRecord {
  return { project: { id: "p1" }, history } as unknown as ProjectRecord;
}

describe("finding hand edits a regeneration would lose", () => {
  it("counts edits made after the last generation", () => {
    const r = record([
      { at: "2026-07-31T10:00:00Z", action: "storyboard.generated" },
      { at: "2026-07-31T11:00:00Z", action: "scene.prompts_edited", detail: "Scene 4" },
      { at: "2026-07-31T11:05:00Z", action: "scene.prompts_edited", detail: "Scene 5" },
    ]);
    expect(handEditedSinceGeneration(r)).toEqual(["Scene 4", "Scene 5"]);
  });

  /** Edits before the last generation are already gone; warning about them is noise. */
  it("ignores edits the last generation already overwrote", () => {
    const r = record([
      { at: "2026-07-31T09:00:00Z", action: "scene.prompts_edited", detail: "Scene 1" },
      { at: "2026-07-31T10:00:00Z", action: "storyboard.generated" },
    ]);
    expect(handEditedSinceGeneration(r)).toEqual([]);
  });

  it("counts one scene once however often it was edited", () => {
    const r = record([
      { at: "2026-07-31T10:00:00Z", action: "storyboard.generated" },
      { at: "2026-07-31T11:00:00Z", action: "scene.prompts_edited", detail: "Scene 5" },
      { at: "2026-07-31T11:30:00Z", action: "scene.prompts_edited", detail: "Scene 5" },
    ]);
    expect(handEditedSinceGeneration(r)).toEqual(["Scene 5"]);
  });

  /**
   * A machine repair rebuilds what the pipeline would produce anyway, so losing
   * it costs nothing and warning about it would train people to ignore the
   * warning.
   */
  it("does not treat a prompt repair as a hand edit", () => {
    const r = record([
      { at: "2026-07-31T10:00:00Z", action: "storyboard.generated" },
      { at: "2026-07-31T11:00:00Z", action: "scene.prompts_repaired", detail: "Prompts repaired" },
    ]);
    expect(handEditedSinceGeneration(r)).toEqual([]);
  });

  it("counts edits made before any storyboard exists", () => {
    const r = record([
      { at: "2026-07-31T11:00:00Z", action: "scene.prompts_edited", detail: "Scene 2" },
    ]);
    expect(handEditedSinceGeneration(r)).toEqual(["Scene 2"]);
  });

  it("has nothing to report on an empty history", () => {
    expect(handEditedSinceGeneration(record([]))).toEqual([]);
    expect(lastActionAt(record([]), "storyboard.generated")).toBeUndefined();
  });
});
