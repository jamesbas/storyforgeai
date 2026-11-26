import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemForm } from "@/components/scheduler/item-form";
import { SchedulerView } from "@/components/scheduler/scheduler-view";
import {
  runTypeAvailability,
  selectedScenesAvailability,
  type ProjectOption,
} from "@/components/scheduler/scheduler-rules";
import type { ScheduleItem } from "@/lib/schemas/schedule";

vi.mock("next/navigation", () => ({ usePathname: () => "/scheduler" }));

const project = (overrides: Partial<ProjectOption> = {}): ProjectOption => ({
  id: "p1",
  title: "Night Harbor",
  generationMode: "video_segments",
  hasStoryboard: true,
  sceneCount: 3,
  ...overrides,
});

const item = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id: "i1",
  projectId: "p1",
  projectTitle: "Night Harbor",
  runType: "storyboard",
  scope: { mode: "all" },
  options: {},
  state: "queued",
  addedAt: "2026-11-24T22:00:00Z",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("add form rules", () => {
  it("disables the stages a generation mode forbids, with the reason", () => {
    const only = runTypeAvailability(project({ generationMode: "storyboard_only" }), [], false);
    expect(only.keyframes).toMatchObject({ enabled: false, reason: expect.stringMatching(/Storyboard only/) });
    expect(only.video.enabled).toBe(false);
    expect(runTypeAvailability(project({ generationMode: "keyframes_only" }), [], false).video.enabled).toBe(false);
  });

  it("allows media for a project without a storyboard only behind a storyboard item", () => {
    const bare = project({ hasStoryboard: false });
    expect(runTypeAvailability(bare, [], false).video.enabled).toBe(false);
    expect(runTypeAvailability(bare, [item()], false).video.enabled).toBe(true);
  });

  it("offers only All scenes behind a same-project storyboard item (FR-6)", () => {
    expect(selectedScenesAvailability(project(), []).enabled).toBe(true);
    expect(selectedScenesAvailability(project(), [item()])).toMatchObject({ enabled: false });
    expect(selectedScenesAvailability(project(), [item({ state: "completed" })]).enabled).toBe(true);
  });

  it("refuses keyframe runs with durable tasks on", () => {
    expect(runTypeAvailability(project(), [], true).keyframes.enabled).toBe(false);
  });
});

describe("ItemForm", () => {
  it("picks scenes with the shortcuts and submits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          scenes: [
            { id: "s1", sceneNumber: 1, title: "Dock", hasKeyframes: true, hasClip: true },
            { id: "s2", sceneNumber: 2, title: "Boat", hasKeyframes: true, hasClip: false },
            { id: "s3", sceneNumber: 3, title: "Light", hasKeyframes: false, hasClip: false },
          ],
        }),
      ),
    );
    const onSubmit = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<ItemForm projects={[project()]} earlier={[]} durableTasks={false} busy={false} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText("Project"), "p1");
    await user.click(screen.getByLabelText("Video generation"));
    await user.click(screen.getByLabelText(/Selected scenes/));
    await user.click(await screen.findByRole("button", { name: "Select scenes without clips" }));
    expect(screen.getByText("2 of 3 picked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "p1",
      runType: "video",
      scope: { mode: "selected", sceneIds: ["s2", "s3"] },
      options: { redoFinished: false },
    });
  });

  it("asks before queueing a storyboard over an existing one (FR-8)", async () => {
    const onSubmit = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<ItemForm projects={[project()]} earlier={[]} durableTasks={false} busy={false} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText("Project"), "p1");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add storyboard run" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("SchedulerView", () => {
  it("names each control's item, reorders from the keyboard and announces the state", async () => {
    const snapshot = {
      schedule: {
        schemaVersion: 1,
        revision: 7,
        state: "idle",
        restartNotice: null,
        items: [
          item({ id: "a", runType: "video", projectTitle: "Night Harbor" }),
          item({ id: "b", runType: "storyboard", projectId: "p2", projectTitle: "Dune Sea" }),
        ],
      },
      current: null,
      waitingFor: null,
      busy: null,
      wangpRestartAvailable: true,
      durableTasks: false,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/scheduler/projects")) return Response.json({ projects: [project()] });
      if (init?.method === "POST") return Response.json(snapshot);
      return Response.json(snapshot);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SchedulerView />);

    const rows = await screen.findAllByTestId("scheduler-row");
    expect(within(rows[1]!).getByText("WanGP will be restarted first to free GPU memory.")).toBeInTheDocument();
    expect(await screen.findByTestId("scheduler-status")).toHaveTextContent("Idle. Add items, then press Start.");

    const moveDown = screen.getByRole("button", { name: "Move down item 1: Video — Night Harbor" });
    moveDown.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/scheduler/items/a",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "moveDown", revision: 7 }) }),
      ),
    );
    expect(screen.getByRole("button", { name: "Remove item 2: Storyboard — Dune Sea" })).toBeInTheDocument();
  });
});
