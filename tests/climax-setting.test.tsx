import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewProjectForm } from "@/components/intake/new-project-form";
import { ClimaxSettings } from "@/components/settings/climax-settings";
import { denouementBudget, earliestClimax, aftermathOverrun } from "@/lib/agents/beat-budget";
import { arcPredatesClimax, climaxPlanOf, writtenAgainstOf } from "@/lib/agents/climax";
import { storyArchitectAgent, storyArchitectSystem } from "@/lib/agents/story-architect-agent";
import { createProject, updateProjectModels } from "@/lib/services/project-service";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * The user names the climax before any agent runs.
 *
 * Left to itself the Story Architect decided both which moment the story
 * builds to and where it lands. On a concept with several big moments the
 * first is a guess, and on the live bar fight the second went wrong: knockout
 * on scene 8 of 15, then seven scenes of aftermath.
 */

describe("the aftermath the user chose", () => {
  it("overrides the automatic budget", () => {
    expect(denouementBudget(15, 0)).toBe(0);
    expect(denouementBudget(15, 3)).toBe(3);
    expect(earliestClimax(15, 0)).toBe(15);
    expect(earliestClimax(15, 3)).toBe(12);
  });

  it("always leaves the climax a segment to land in", () => {
    expect(denouementBudget(2, 3)).toBe(1);
    expect(earliestClimax(2, 3)).toBe(1);
  });

  it("measures an overrun against the chosen budget", () => {
    expect(aftermathOverrun(13, 15, 0)).toBe(2);
    expect(aftermathOverrun(12, 15, 3)).toBe(0);
  });
});

describe("what an arc was written against", () => {
  it("reads nothing from a project with no climax set", () => {
    expect(climaxPlanOf({})).toEqual({});
    expect(climaxPlanOf({ climax: "   " })).toEqual({});
  });

  it("records the settings, trimmed", () => {
    expect(writtenAgainstOf({ climax: " Marcus drops Dale ", aftermathScenes: 1 })).toEqual({
      climax: "Marcus drops Dale",
      aftermathScenes: 1,
    });
  });

  it("calls an arc stale once the climax changes, and not before", () => {
    const plan = { writtenAgainst: { climax: "Marcus drops Dale" } };
    expect(arcPredatesClimax({ climax: "Marcus drops Dale" }, plan)).toBe(false);
    expect(arcPredatesClimax({ climax: "Jenna breaks a bottle" }, plan)).toBe(true);
    expect(arcPredatesClimax({ climax: "Marcus drops Dale", aftermathScenes: 0 }, plan)).toBe(true);
  });

  /** Arcs written before the setting existed must not all light up as stale. */
  it("leaves an older arc alone until something is actually set", () => {
    expect(arcPredatesClimax({}, {})).toBe(false);
    expect(arcPredatesClimax({ climax: "Marcus drops Dale" }, {})).toBe(true);
    expect(arcPredatesClimax({ climax: "x" }, undefined)).toBe(false);
  });
});

describe("what the Story Architect is told", () => {
  it("names the user's climax and says it is not the model's to change", () => {
    const system = storyArchitectSystem(20, 15, { description: "Marcus drops Dale" });
    expect(system).toContain('"Marcus drops Dale"');
    expect(system).toContain("not yours to change");
  });

  it("places the climax by the chosen aftermath", () => {
    const system = storyArchitectSystem(20, 15, { aftermath: 1 });
    expect(system).toContain("belongs at segment 14 or later of 15");
    expect(system).toMatch(/at most 1 of the final beats may be aftermath/i);
  });

  it("says the piece ends on its climax when no aftermath is allowed", () => {
    const system = storyArchitectSystem(20, 15, { aftermath: 0 });
    expect(system).toContain("the piece ends on its climax");
    expect(system).not.toMatch(/at most 0/i);
  });

  it("says nothing new when the user set nothing", () => {
    expect(storyArchitectSystem(20, 15)).not.toContain("not yours to change");
  });
});

const baseProject = {
  id: "p",
  title: "Last call",
  concept: "An ex-boxer steps in at a roadside bar.",
  segmentCount: 15,
  segmentSeconds: 20,
  modelStrategy: "auto",
  style: "cinematic",
  tone: "neutral",
  creativeMode: "film_short",
} as unknown as Project;

function ctxFor(project: Project, executions: ArtifactExecution[] = []): AgentContext {
  return {
    project,
    brief: { logline: "l", synopsis: "s" },
    onExecution: (e: ArtifactExecution) => executions.push(e),
  } as unknown as AgentContext;
}

const WORDS = ["ladder", "kettle", "harbour", "marble", "lantern", "cactus", "violin", "anchor"];
const beat = (n: number) => `segment${n} ${WORDS[n % 8]} ${WORDS[(n * 3) % 8]} ${WORDS[(n * 5) % 8]}`;

function fake(openings: Array<{ climax?: number }>) {
  const systems: string[] = [];
  let opened = 0;
  const provider = {
    name: "fake",
    async generateJson(system: string, user: string) {
      systems.push(system);
      const asked = (JSON.parse(user) as { writeOnlyTheseSegments?: number[] })
        .writeOnlyTheseSegments;
      if (asked) {
        return {
          entries: Object.fromEntries(asked.map((n) => [String(n), beat(n)])),
          emotions: Object.fromEntries(asked.map((n) => [String(n), `feeling ${n}`])),
        };
      }
      const o = openings[Math.min(opened, openings.length - 1)]!;
      opened += 1;
      return {
        projectId: "p",
        title: "T",
        logline: "l",
        segmentBeats: Array.from({ length: 8 }, (_, i) => beat(i + 1)),
        emotionalProgression: Array.from({ length: 8 }, (_, i) => `feeling ${i + 1}`),
        ...(o.climax !== undefined ? { climaxSegment: o.climax } : {}),
      };
    },
  } as unknown as PlanningProvider;
  return { provider, systems, openings: () => opened };
}

describe("an arc written to the user's climax", () => {
  const withClimax = {
    ...baseProject,
    climax: "Marcus drops Dale with one punch",
    aftermathScenes: 1,
  } as Project;

  it("names it in the opening and in the window that holds it", async () => {
    const { provider, systems } = fake([{}]);
    await storyArchitectAgent(ctxFor(withClimax), provider);

    expect(systems[0]).toContain('The climax ("Marcus drops Dale with one punch") is at segment 14');
    expect(systems[1]).toContain(
      'the climax ("Marcus drops Dale with one punch") belongs in this window, at segment 14',
    );
  });

  it("records what the arc was written against", async () => {
    const { provider } = fake([{}]);
    const plan = await storyArchitectAgent(ctxFor(withClimax), provider);

    expect(plan.writtenAgainst).toEqual({
      climax: "Marcus drops Dale with one punch",
      aftermathScenes: 1,
    });
    expect(arcPredatesClimax(withClimax, plan)).toBe(false);
  });

  it("names the climax in the rewrite of an opening that spent it early", async () => {
    const { provider, systems, openings } = fake([{ climax: 8 }, {}]);
    await storyArchitectAgent(ctxFor(withClimax), provider);

    expect(openings()).toBe(2);
    expect(systems[1]).toContain('wrote the climax ("Marcus drops Dale with one punch") in segment 8');
    expect(systems[1]).toContain("at most 1 is allowed");
  });

  /** A longer landing the user asked for is not an overrun. */
  it("does not rewrite a climax the chosen aftermath allows", async () => {
    const executions: ArtifactExecution[] = [];
    const longLanding = { ...baseProject, segmentCount: 8, aftermathScenes: 3 } as Project;
    const { provider, openings } = fake([{ climax: 5 }]);

    await storyArchitectAgent(ctxFor(longLanding, executions), provider);

    expect(openings()).toBe(1);
    expect(executions.find((e) => e.artifact === "story_plan")?.detail ?? "").not.toContain(
      "climax",
    );
  });
});

describe("storing the climax on a project", () => {
  it("keeps it from the New Project form, trimmed", async () => {
    const project = await createProject({
      concept: "An ex-boxer steps in at a roadside bar.",
      requestedDurationSeconds: 300,
      climax: "  Marcus drops Dale  ",
      aftermathScenes: 1,
    });

    expect(project.climax).toBe("Marcus drops Dale");
    expect(project.aftermathScenes).toBe(1);
  });

  it("leaves both absent when the form left them blank", async () => {
    const project = await createProject({
      concept: "An ex-boxer steps in at a roadside bar.",
      requestedDurationSeconds: 300,
      climax: "   ",
    });

    expect(project.climax).toBeUndefined();
    expect(project.aftermathScenes).toBeUndefined();
  });

  it("changes and clears from Project Settings", async () => {
    const project = await createProject({
      concept: "An ex-boxer steps in at a roadside bar.",
      requestedDurationSeconds: 300,
      climax: "Marcus drops Dale",
      aftermathScenes: 2,
    });

    const changed = await updateProjectModels(project.id, { climax: "Jenna breaks a bottle" });
    expect(changed.project.climax).toBe("Jenna breaks a bottle");
    expect(changed.project.aftermathScenes).toBe(2);

    const cleared = await updateProjectModels(project.id, { climax: "", aftermathScenes: null });
    expect(cleared.project.climax).toBeUndefined();
    expect(cleared.project.aftermathScenes).toBeUndefined();
  });

  it("refuses an aftermath past the limit", async () => {
    await expect(
      createProject({
        concept: "An ex-boxer steps in at a roadside bar.",
        requestedDurationSeconds: 300,
        aftermathScenes: 9,
      }),
    ).rejects.toThrow();
  });
});

describe("the New Project form", () => {
  it("sends the climax and the scenes after it", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^concept$/i), "An ex-boxer steps in at a bar.");
    await user.type(screen.getByLabelText(/climax — optional/i), "Marcus drops Dale");
    await user.selectOptions(screen.getByLabelText(/scenes after the climax/i), "1");
    await user.click(screen.getByRole("button", { name: /create storyboard/i }));

    const values = onSubmit.mock.calls[0]![0];
    expect(values.climax).toBe("Marcus drops Dale");
    expect(values.aftermathScenes).toBe(1);
  });

  it("sends neither when both are left alone", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^concept$/i), "An ex-boxer steps in at a bar.");
    await user.click(screen.getByRole("button", { name: /create storyboard/i }));

    const values = onSubmit.mock.calls[0]![0];
    expect(values).not.toHaveProperty("climax");
    expect(values).not.toHaveProperty("aftermathScenes");
  });

  it("says where the climax will land for the runtime chosen", async () => {
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={vi.fn()} />);

    // 60s at 20s clips is three scenes; one closing scene puts the climax at 2.
    expect(screen.getByTestId("climax-position")).toHaveTextContent("scene 2 of 3");
    await user.selectOptions(screen.getByLabelText(/scenes after the climax/i), "0");
    expect(screen.getByTestId("climax-position")).toHaveTextContent("scene 3 of 3");
  });
});

describe("the Project Settings climax", () => {
  it("saves only on the button, and only when something changed", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <ClimaxSettings
        climax="Marcus drops Dale"
        aftermath={undefined}
        segmentCount={15}
        hasArc
        busy={false}
        onSave={onSave}
      />,
    );

    const button = screen.getByRole("button", { name: /save climax/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId("climax-settings")).toHaveTextContent("marks it out of date");

    await user.selectOptions(screen.getByLabelText(/scenes after the climax/i), "0");
    await user.click(button);
    expect(onSave).toHaveBeenCalledWith("Marcus drops Dale", 0);
  });
});
