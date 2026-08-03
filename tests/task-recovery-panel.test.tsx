import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskRecoveryPanel } from "@/components/storyboard/task-recovery-panel";
import type { Task, TaskEntry, TaskFile } from "@/lib/schemas/tasks";

function entry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: `e-${Math.random()}`,
    ref: "p1-scene-004",
    label: "Scene 4",
    order: 4,
    state: "pending",
    attempts: 0,
    history: [],
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    kind: "scene_batch",
    state: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: [entry()],
    ...overrides,
  };
}

function file(tasks: Task[]): TaskFile {
  return { schemaVersion: 1, revision: 1, tasks };
}

function mockFetch(payload: TaskFile) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  } as Response);
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("the recovery panel", () => {
  it("shows nothing when a project has no background work", async () => {
    vi.stubGlobal("fetch", mockFetch(file([])));
    const { container } = render(<TaskRecoveryPanel projectId="p1" />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("lists each entry with its state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        file([
          task({
            entries: [
              entry({ label: "Scene 1", state: "completed" }),
              entry({ label: "Scene 2", state: "running" }),
            ],
          }),
        ]),
      ),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("task-entry")).toHaveLength(2));
    expect(screen.getByText("Done")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
  });

  /**
   * §7: the restart message must say what happened and what is safe to do, and
   * must never claim a job was stopped when it may still be running.
   */
  it("explains an ambiguous submission without claiming anything was cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        file([
          task({
            state: "interrupted",
            entries: [entry({ label: "Scene 4", state: "submission_unknown" })],
          }),
        ]),
      ),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    const message = await screen.findByTestId("recovery-message");
    expect(message).toHaveTextContent(/interrupted while Scene 4/i);
    expect(message).toHaveTextContent(/may or may not have accepted/i);
    expect(message).toHaveTextContent(/nothing was resent/i);
    expect(message.textContent).not.toMatch(/cancelled/i);
  });

  it("names the state of an unknown submission honestly", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(file([task({ entries: [entry({ state: "submission_unknown" })] })])),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    expect(await screen.findByText("Unknown — may be running")).toBeVisible();
  });

  it("does not call a stopping job cancelled while it is still running", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(file([task({ entries: [entry({ state: "cancel_requested" })] })])),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    expect(await screen.findByText("Stopping after this step")).toBeVisible();
  });

  it("offers Resume for work that can be checked with the backend", async () => {
    vi.stubGlobal("fetch", mockFetch(file([task({ entries: [entry({ state: "reconciling" })] })])));
    render(<TaskRecoveryPanel projectId="p1" />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("offers Retry for failed work", async () => {
    vi.stubGlobal("fetch", mockFetch(file([task({ entries: [entry({ state: "failed" })] })])));
    render(<TaskRecoveryPanel projectId="p1" />);
    expect(await screen.findByRole("button", { name: "Retry failed" })).toBeVisible();
  });

  it("offers Cancel remaining only while something is unfinished", async () => {
    vi.stubGlobal("fetch", mockFetch(file([task({ state: "completed", entries: [entry({ state: "completed" })] })])));
    render(<TaskRecoveryPanel projectId="p1" />);
    await screen.findByTestId("task-recovery");
    expect(screen.queryByRole("button", { name: "Cancel remaining" })).toBeNull();
  });

  it("sends the retry action for the right task", async () => {
    const fetchMock = mockFetch(file([task({ entries: [entry({ state: "failed" })] })]));
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskRecoveryPanel projectId="p1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry failed" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        action: "retry",
        taskId: "t1",
      });
    });
  });

  /** Stopping tracking does not stop the GPU, and the dialog must say so. */
  it("warns that stopping tracking does not stop the render", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(file([task({ entries: [entry({ state: "interrupted" })] })])),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop tracking" }));

    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveAccessibleName("Stop tracking this run?");
    expect(dialog).toHaveTextContent(/may still be rendering/i);
    expect(dialog).toHaveTextContent(/still be using the GPU/i);
  });

  it("dismisses completed work without touching anything unresolved", async () => {
    const fetchMock = mockFetch(
      file([
        task({ id: "done", state: "completed", entries: [entry({ state: "completed" })] }),
        task({ id: "stuck", state: "interrupted", entries: [entry({ state: "interrupted" })] }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskRecoveryPanel projectId="p1" />);

    await userEvent.click(await screen.findByRole("button", { name: /Dismiss 1 completed/ }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
      expect(JSON.parse((call![1] as RequestInit).body as string).action).toBe("dismiss");
    });
  });

  it("shows how long an entry has been going", async () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    vi.stubGlobal(
      "fetch",
      mockFetch(file([task({ entries: [entry({ state: "running", startedAt })] })])),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    expect(await screen.findByText(/1m 3\ds/)).toBeVisible();
  });
});
