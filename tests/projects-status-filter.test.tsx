import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import ProjectsPage from "@/app/projects/page";
import {
  countByStatus,
  filterProjects,
  projectStatusLabel,
} from "@/components/intake/project-filter";
import type { Project } from "@/lib/schemas/project";

vi.mock("@/components/shell/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/intake/import-project", () => ({ ImportProject: () => null }));

function project(id: string, title: string, status: Project["status"], concept = "x"): Project {
  const now = new Date().toISOString();
  return {
    id,
    title,
    concept,
    requestedDurationSeconds: 20,
    segmentSeconds: 20,
    segmentCount: 1,
    generatedDurationSeconds: 20,
    finalTrimSeconds: 0,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "calm",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status,
    createdAt: now,
    updatedAt: now,
  } as Project;
}

const projects = [
  project("p1", "Harbour Lights", "assembled", "a lighthouse at dusk"),
  project("p2", "Night Market", "needs_review", "street food"),
  project("p3", "Harbour Fog", "needs_review"),
  project("p4", "Desert Run", "draft"),
];

describe("filterProjects", () => {
  it("returns everything when unfiltered", () => {
    expect(filterProjects(projects, "  ", "all")).toBe(projects);
  });

  it("narrows by status", () => {
    expect(filterProjects(projects, "", "needs_review").map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("combines status with the title/concept search", () => {
    expect(filterProjects(projects, "harbour", "needs_review").map((p) => p.id)).toEqual(["p3"]);
    expect(filterProjects(projects, "LIGHTHOUSE", "all").map((p) => p.id)).toEqual(["p1"]);
  });

  it("counts every status, including empty ones", () => {
    const counts = countByStatus(projects);
    expect(counts).toMatchObject({ assembled: 1, needs_review: 2, draft: 1, generating: 0 });
  });

  it("labels statuses for people", () => {
    expect(projectStatusLabel("needs_review")).toBe("Needs review");
    expect(projectStatusLabel("storyboard_ready")).toBe("Storyboard ready");
  });
});

describe("the Projects page status filter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ projects }), { status: 200 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows only projects in the chosen status", async () => {
    render(<ProjectsPage />);
    const select = await screen.findByLabelText("Filter by status");
    expect(screen.getByText("4 of 4")).toBeInTheDocument();

    expect(within(select).getByRole("option", { name: "Generating (0)" })).toBeDisabled();
    await userEvent.selectOptions(select, "needs_review");

    expect(screen.getByText("2 of 4")).toBeInTheDocument();
    expect(screen.getByText("Night Market")).toBeInTheDocument();
    expect(screen.getByText("Harbour Fog")).toBeInTheDocument();
    expect(screen.queryByText("Harbour Lights")).not.toBeInTheDocument();
  });

  it("says when a search finds nothing in the chosen status", async () => {
    render(<ProjectsPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Filter by status"), "assembled");
    await userEvent.type(screen.getByLabelText("Search projects"), "desert");

    expect(screen.getByText("No project in Assembled matches “desert”.")).toBeInTheDocument();
  });
});
