import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateWorldBible,
  generateCinematographyPlan,
  generateStoryboard,
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
