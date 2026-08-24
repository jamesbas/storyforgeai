import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateStoryboard, getProjectRecord, createProject } from "@/lib/services/project-service";
import { latestExecution } from "@/lib/schemas/provenance";
import type { StoryPlan } from "@/lib/schemas/agents";

/**
 * A narrative arc written by the builder used to be permanent.
 *
 * The arc is generated once and every later run reuses it, which is right when
 * a model wrote it and wrong when the Story Architect failed. One live project
 * carried `Advance beat 7 of the narrative and raise the stakes.` for all
 * twenty-four segments: the Storyboard Artist was handed template text instead
 * of a story, invented an arc of its own four cards at a time, and by the last
 * batch had nothing left and repeated itself — five scenes titled the same.
 *
 * Nothing recorded the fallback either, because the canvas path called the
 * Story Architect without collecting its provenance.
 */

const BUILDER_BEAT = /Advance beat \d+ of the narrative/;

async function project(concept: string) {
  const created = await createProject({
    concept,
    requestedDurationSeconds: 60,
    generationMode: "storyboard_only",
  });
  return created.id;
}

beforeEach(() => {
  vi.stubEnv("AI_PLANNING_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a narrative arc the builder wrote", () => {
  /**
   * Demo mode has no provider, so the arc is the builder's and rewriting it
   * would only produce the same template. It must not churn the record.
   */
  it("is left alone when there is no model to improve it", async () => {
    const id = await project("A lighthouse keeper befriends a storm at dawn.");

    const first = await generateStoryboard(id);
    const beats = first.storyPlan!.segmentBeats;
    expect(beats.some((b) => BUILDER_BEAT.test(b))).toBe(true);

    const second = await generateStoryboard(id);
    expect(second.storyPlan!.segmentBeats).toEqual(beats);
  });

  it("records that the builder wrote it, so nothing has to guess later", async () => {
    const id = await project("A diver returns to a wreck she has avoided for years.");

    const record = await generateStoryboard(id);
    const run = latestExecution(record.executions, "story_plan");

    expect(run?.source).toBe("deterministic");
  });

  /** The arc has to be reused, not rewritten, once a model has written it. */
  it("keeps a stored arc that carries real beats", async () => {
    const id = await project("A courier crosses a city that is quietly emptying.");
    const written: StoryPlan["segmentBeats"] = [];

    const first = await generateStoryboard(id);
    written.push(...first.storyPlan!.segmentBeats);

    const second = await generateStoryboard(id);
    expect(second.storyPlan!.segmentBeats).toEqual(written);
  });
});
