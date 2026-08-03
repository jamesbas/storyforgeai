import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";
import { TaskRecoveryPanel } from "@/components/storyboard/task-recovery-panel";
import { ImportProject } from "@/components/intake/import-project";
import type { Task, TaskEntry, TaskFile } from "@/lib/schemas/tasks";

afterEach(() => vi.restoreAllMocks());

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

const taskFile = (tasks: Task[]): TaskFile => ({ schemaVersion: 1, revision: 1, tasks });

/**
 * The rule SPEC-009B turns on: these screens poll every few seconds, so a live
 * region fed raw progress reads the same sentence forever.
 */
describe("announcing transitions rather than ticks", () => {
  function Poller({ messages }: { messages: (string | null)[] }) {
    const [i, setI] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setI((n) => n + 1)}>
          tick
        </button>
        <AsyncStatus message={messages[i] ?? null} />
      </>
    );
  }

  it("says nothing new when a poll returns the same state", async () => {
    render(<Poller messages={["Rendering clips. 2 of 5 scenes done.", "Rendering clips. 2 of 5 scenes done."]} />);
    const region = screen.getByTestId("async-status");
    const before = region.textContent;
    await userEvent.click(screen.getByRole("button", { name: "tick" }));
    expect(screen.getByTestId("async-status").textContent).toBe(before);
  });

  it("announces when the phase actually moves on", async () => {
    render(
      <Poller
        messages={["Rendering keyframes. 5 of 5 scenes done.", "Rendering clips. 0 of 5 scenes done."]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "tick" }));
    expect(screen.getByTestId("async-status")).toHaveTextContent("Rendering clips");
  });

  it("reads the whole sentence rather than the changed word", () => {
    // Without aria-atomic, "2 of 5" becoming "3 of 5" announces a bare "3".
    render(<AsyncStatus message="3 of 5 scenes done." />);
    expect(screen.getByTestId("async-status")).toHaveAttribute("aria-atomic", "true");
  });

  it("keeps several regions on one screen distinguishable", () => {
    render(
      <>
        <AsyncStatus testId="batch-status" message="Batch running." />
        <AsyncStatus testId="recovery-status" message="Retry queued." />
      </>,
    );
    expect(screen.getByTestId("batch-status")).toBeVisible();
    expect(screen.getByTestId("recovery-status")).toBeVisible();
  });
});

/**
 * §13: private prompt and media content must not reach a global live region.
 * This app has adult presets and no moderation, so a scene title read aloud is
 * a real consequence.
 */
describe("what is never announced", () => {
  it("keeps the recovery panel to labels and states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          taskFile([task({ entries: [entry({ state: "submission_unknown", label: "Scene 4" })] })]),
      } as Response),
    );
    render(<TaskRecoveryPanel projectId="p1" />);
    const message = await screen.findByTestId("recovery-message");
    // "Scene 4" is a position, not a title.
    expect(message).toHaveTextContent(/Scene 4/);
    expect(message.textContent).not.toMatch(/prompt|\.mp4|\.png|C:\\/i);
  });

  it("announces import as counts, leaving the project title visible only", async () => {
    const outcome = {
      project: { id: "p2", title: "A Very Private Title" },
      source: "record" as const,
      missingPlans: ["director"],
      attempts: 3,
      missingMedia: 2,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => outcome } as Response),
    );

    const { container } = render(<ImportProject onImported={vi.fn()} />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["{}"], "project.json", { type: "application/json" });
    // jsdom's File has no usable text(); the component reads the upload with it.
    Object.defineProperty(file, "text", { value: async () => "{}" });
    await userEvent.upload(input, file);

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent(/1 plans missing, 2 media files missing/);
    // The title is on screen but out of the live region.
    expect(status.textContent).not.toContain("A Very Private Title");
    expect(screen.getByTestId("import-outcome")).toHaveTextContent("A Very Private Title");
  });
});

describe("recovery keyboard behaviour", () => {
  function mockTasks(tasks: Task[]) {
    return vi.fn().mockResolvedValue({ ok: true, json: async () => taskFile(tasks) } as Response);
  }

  it("announces the outcome of an action", async () => {
    vi.stubGlobal("fetch", mockTasks([task({ entries: [entry({ state: "failed" })] })]));
    render(<TaskRecoveryPanel projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry failed" }));
    await waitFor(() =>
      expect(screen.getByTestId("recovery-status")).toHaveTextContent("Retry queued"),
    );
  });

  it("does not claim a stopped job was cancelled", async () => {
    vi.stubGlobal("fetch", mockTasks([task({ entries: [entry({ state: "interrupted" })] })]));
    render(<TaskRecoveryPanel projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop tracking" }));

    // Both the trigger and the dialog's confirm are named "Stop tracking".
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.click(within(dialog).getByRole("button", { name: "Stop tracking" }));

    await waitFor(() =>
      expect(screen.getByTestId("recovery-status")).toHaveTextContent(/may still be running/i),
    );
  });

  it("returns focus to the trigger when the confirmation is dismissed", async () => {
    vi.stubGlobal("fetch", mockTasks([task({ entries: [entry({ state: "interrupted" })] })]));
    render(<TaskRecoveryPanel projectId="p1" />);

    const trigger = await screen.findByRole("button", { name: "Stop tracking" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop tracking" })).toHaveFocus(),
    );
  });

  it("catches focus on the panel heading when the pressed button disappears", async () => {
    // Retrying removes the Retry button, which would otherwise drop focus to
    // the document and lose a keyboard user's place.
    const responses = [
      taskFile([task({ entries: [entry({ state: "failed" })] })]),
      taskFile([task({ entries: [entry({ state: "pending" })] })]),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => responses[Math.min(call++, responses.length - 1)],
      })),
    );

    render(<TaskRecoveryPanel projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry failed" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Background work" })).toHaveFocus();
    });
  });

  it("gives the heading a programmatic focus target without adding it to tab order", async () => {
    vi.stubGlobal("fetch", mockTasks([task()]));
    render(<TaskRecoveryPanel projectId="p1" />);
    const heading = await screen.findByRole("heading", { name: "Background work" });
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

describe("status meaning without colour", () => {
  it("states failure in words, not only in red", () => {
    render(<AsyncStatus message="Generation finished. 3 done, 1 failed." failed />);
    const region = screen.getByTestId("async-status");
    expect(region).toHaveAttribute("role", "alert");
    expect(region.textContent).toMatch(/failed/i);
  });

  it("marks work in progress for assistive technology", () => {
    render(<AsyncStatus message="Assembling the rough cut…" busy />);
    expect(screen.getByTestId("async-status")).toHaveAttribute("aria-busy", "true");
  });
});
