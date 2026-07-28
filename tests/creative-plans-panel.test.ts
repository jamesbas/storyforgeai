import { describe, it, expect } from "vitest";
import { planStates } from "@/components/storyboard/creative-plans-panel";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Staleness detection for the canvas plans.
 *
 * The plans are read once, when the storyboard is generated, and baked into the
 * scene prompts. A plan generated afterwards therefore changes nothing until the
 * storyboard is regenerated — a silent no-op the canvas cannot show, because it
 * reports the plan as "ready" either way. Comparing history timestamps is the
 * only signal available, so it is worth pinning.
 */

const plan = { placeholder: true } as never;

function recordWith(history: { at: string; action: string }[], plans: Partial<ProjectRecord> = {}) {
  return {
    project: {} as ProjectRecord["project"],
    storyboard: {} as ProjectRecord["storyboard"],
    history,
    ...plans,
  } as ProjectRecord;
}

describe("creative plan staleness", () => {
  it("marks a plan generated after the storyboard as not applied", () => {
    const record = recordWith(
      [
        { at: "2026-07-28T12:02:53Z", action: "storyboard.generated" },
        { at: "2026-07-28T12:06:19Z", action: "directorial_plan.generated" },
      ],
      { directorialPlan: plan },
    );

    const { states, staleCount } = planStates(record);
    expect(states.find((s) => s.label === "Director")?.state).toBe("stale");
    expect(staleCount).toBe(1);
  });

  it("marks a plan generated before the storyboard as applied", () => {
    const record = recordWith(
      [
        { at: "2026-07-28T12:00:00Z", action: "directorial_plan.generated" },
        { at: "2026-07-28T12:02:53Z", action: "storyboard.generated" },
      ],
      { directorialPlan: plan },
    );

    expect(planStates(record).states.find((s) => s.label === "Director")?.state).toBe("applied");
  });

  /** Regeneration is the fix, so a later storyboard must clear the warning. */
  it("clears staleness once the storyboard is regenerated", () => {
    const record = recordWith(
      [
        { at: "2026-07-28T12:02:53Z", action: "storyboard.generated" },
        { at: "2026-07-28T12:06:19Z", action: "directorial_plan.generated" },
        { at: "2026-07-28T12:20:00Z", action: "storyboard.generated" },
      ],
      { directorialPlan: plan },
    );

    expect(planStates(record).staleCount).toBe(0);
  });

  it("reports plans that were never generated", () => {
    const record = recordWith([{ at: "2026-07-28T12:02:53Z", action: "storyboard.generated" }]);
    const { states, missingCount } = planStates(record);

    expect(missingCount).toBe(4);
    expect(states.every((s) => s.state === "missing")).toBe(true);
  });

  /**
   * Without history there is no evidence either way, and a false "not applied"
   * warning would push users into pointless regenerations.
   */
  it("assumes a plan applies when there is no history to prove otherwise", () => {
    const record = recordWith([], { artDirectionPlan: plan });
    expect(planStates(record).states.find((s) => s.label === "Art Director")?.state).toBe("applied");
  });

  it("counts each stale plan independently", () => {
    const record = recordWith(
      [
        { at: "2026-07-28T12:00:00Z", action: "world_bible.generated" },
        { at: "2026-07-28T12:02:53Z", action: "storyboard.generated" },
        { at: "2026-07-28T12:06:19Z", action: "directorial_plan.generated" },
        { at: "2026-07-28T12:15:07Z", action: "cinematography_plan.generated" },
      ],
      { worldBible: plan, directorialPlan: plan, cinematographyPlan: plan },
    );

    const { states, staleCount, missingCount } = planStates(record);
    expect(states.find((s) => s.label === "World Builder")?.state).toBe("applied");
    expect(staleCount).toBe(2);
    expect(missingCount).toBe(1);
  });
});
