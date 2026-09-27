import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateWorldBible,
  generateCinematographyPlan,
  generateStoryboard,
  generateStoryPlan as generateStoryPlanFor,
  storyPlanNeedsWriting,
  updatePlan,
} from "@/lib/services/project-service";
import { planSpecFor, PLAN_SPECS } from "@/lib/agents/plan-fields";
import { planStates } from "@/components/storyboard/creative-plans-panel";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { WorldBible } from "@/lib/schemas/canvas";

/**
 * Reading and editing what the canvas agents produced.
 *
 * The plans steer every render but were visible only as a two-line summary,
 * so a wrong premise could only be fixed by regenerating and hoping.
 */

async function projectWithWorld(): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 60,
  });
  return generateWorldBible(project.id);
}

describe("what each plan declares as editable", () => {
  /** projectId is derived; a browser must not be able to move a plan. */
  it("never offers projectId", () => {
    for (const spec of PLAN_SPECS) {
      expect(spec.fields.map((f) => f.key)).not.toContain("projectId");
    }
  });

  /**
   * `audioPlan.cues` holds generated audio with file paths and approval state.
   * Editing those by hand would strand real media on disk.
   */
  it("never offers the generated audio cues", () => {
    const audio = planSpecFor("audio")!;
    expect(audio.fields.map((f) => f.key)).not.toContain("cues");
  });

  it("only names fields the schema actually has", () => {
    for (const spec of PLAN_SPECS) {
      const shape = Object.keys(
        (spec.schema as unknown as { shape: Record<string, unknown> }).shape,
      );
      for (const field of spec.fields) expect(shape).toContain(field.key);
    }
  });
});

describe("editing a plan", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("keeps the edit and leaves the rest alone", async () => {
    const record = await projectWithWorld();
    const before = record.worldBible!;

    const updated = await updatePlan(record.project.id, "world", {
      premise: "The water never drains.",
    });

    const after = updated.worldBible as WorldBible;
    expect(after.premise).toBe("The water never drains.");
    expect(after.universeRules).toEqual(before.universeRules);
    expect(after.projectId).toBe(record.project.id);
  });

  it("takes only the fields the plan declares", async () => {
    const record = await projectWithWorld();
    const updated = await updatePlan(record.project.id, "world", {
      premise: "Kept.",
      projectId: "somebody-elses-project",
    });
    expect((updated.worldBible as WorldBible).projectId).toBe(record.project.id);
  });

  it("rejects a value the schema will not accept", async () => {
    const record = await projectWithWorld();
    await expect(
      updatePlan(record.project.id, "world", { universeRules: "not a list" }),
    ).rejects.toThrow(/universeRules/);
  });

  it("refuses a plan the agent has not produced", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    await expect(updatePlan(project.id, "world", { premise: "x" })).rejects.toThrow(
      /Run the World Bible agent/,
    );
  });

  it("refuses an agent with no editable plan", async () => {
    const record = await projectWithWorld();
    await expect(updatePlan(record.project.id, "variants", {})).rejects.toThrow(
      /No editable plan/,
    );
  });

  /**
   * The Storyboard screen decides "not applied yet" by comparing history
   * timestamps. Without an entry the edit would never reach a render while the
   * badge still claimed the plan applied.
   */
  it("marks the storyboard stale so the edit is known not to have reached it", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    await generateCinematographyPlan(project.id);
    let record = await generateStoryboard(project.id);

    const fresh = planStates(record).states.find((s) => s.label === "Cinematographer");
    expect(fresh?.state).toBe("applied");

    // History sorts by timestamp, so the edit must land after the storyboard.
    await new Promise((r) => setTimeout(r, 5));
    record = await updatePlan(project.id, "cinematographer", {
      cameraLanguage: "Handheld throughout.",
    });

    const after = planStates(record).states.find((s) => s.label === "Cinematographer");
    expect(after?.state).toBe("stale");
  });
});

/**
 * The arc was the one artifact that could not be edited, so a beat the model
 * got wrong — a fight finished in one scene, a climax on the wrong event —
 * could only be fixed by regenerating the whole arc and hoping.
 */
describe("editing the story arc", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  async function projectWithArc(): Promise<ProjectRecord> {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    return generateStoryPlanFor(project.id);
  }

  const beatsOf = (record: ProjectRecord) => record.storyPlan!.segmentBeats;

  it("keeps edited beats, continuations and climax", async () => {
    const record = await projectWithArc();
    const beats = beatsOf(record).map((b, i) => (i === 1 ? "The courier wades into the square." : b));

    const updated = await updatePlan(record.project.id, "story", {
      segmentBeats: beats,
      continuedSegments: [3],
      climaxSegment: 2,
    });

    expect(updated.storyPlan!.segmentBeats[1]).toBe("The courier wades into the square.");
    expect(updated.storyPlan!.continuedSegments).toEqual([3]);
    expect(updated.storyPlan!.climaxSegment).toBe(2);
    expect(updated.storyPlan!.logline).toBe(record.storyPlan!.logline);
  });

  it("clears the climax when it is left blank", async () => {
    const record = await projectWithArc();
    await updatePlan(record.project.id, "story", { climaxSegment: 2 });

    const cleared = await updatePlan(record.project.id, "story", { climaxSegment: null });

    expect(cleared.storyPlan!.climaxSegment).toBeUndefined();
  });

  /** Every later agent slices the arc by segment number. */
  it("refuses an arc with a beat missing", async () => {
    const record = await projectWithArc();
    await expect(
      updatePlan(record.project.id, "story", { segmentBeats: beatsOf(record).slice(1) }),
    ).rejects.toThrow(/needs 3 entries/);
  });

  it("refuses a blank beat by its number", async () => {
    const record = await projectWithArc();
    const beats = [...beatsOf(record)];
    beats[1] = "  ";
    await expect(updatePlan(record.project.id, "story", { segmentBeats: beats })).rejects.toThrow(
      /Story beat 2 is empty/,
    );
  });

  it("refuses a continuation on segment 1 or past the end", async () => {
    const record = await projectWithArc();
    await expect(
      updatePlan(record.project.id, "story", { continuedSegments: [1] }),
    ).rejects.toThrow(/segment 1 has nothing to continue/);
    await expect(updatePlan(record.project.id, "story", { climaxSegment: 9 })).rejects.toThrow(
      /Climax segment 9/,
    );
  });

  /**
   * A hand-edited arc must survive the storyboard even when the arc it
   * replaced came from the builder — otherwise the guard that rewrites a
   * template arc would throw the user's beats away with it.
   */
  it("hands the edited beats to the storyboard", async () => {
    const record = await projectWithArc();
    const beats = beatsOf(record).map((b, i) => (i === 0 ? "The courier ties the parcel to her back." : b));
    await new Promise((r) => setTimeout(r, 5));
    await updatePlan(record.project.id, "story", { segmentBeats: beats });

    const boarded = await generateStoryboard(record.project.id);

    expect(boarded.storyPlan!.segmentBeats[0]).toBe("The courier ties the parcel to her back.");
  });

  it("is not rewritten over by the guard that replaces template arcs", () => {
    const templateArc = {
      project: {},
      storyPlan: { segmentBeats: ["Advance beat 1 of the narrative."] },
      executions: [
        {
          artifact: "story_plan",
          source: "deterministic",
          status: "degraded",
          startedAt: "2026-09-27T10:00:00.000Z",
          finishedAt: "2026-09-27T10:00:01.000Z",
        },
      ],
      history: [] as { at: string; action: string }[],
    } as unknown as ProjectRecord;

    // A template arc nobody touched is still replaced when a model is available.
    expect(storyPlanNeedsWriting(templateArc, true)).toBe(true);

    const edited = {
      ...templateArc,
      history: [{ at: "2026-09-27T10:05:00.000Z", action: "story_plan.edited" }],
    } as unknown as ProjectRecord;
    expect(storyPlanNeedsWriting(edited, true)).toBe(false);
  });
});
