import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { AsyncStatus } from "@/components/shared/async-status";
import { ProjectListItem } from "@/components/intake/project-list-item";
import type { Project } from "@/lib/schemas/project";

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "p1",
    title: "Harbour Lights",
    concept: "x",
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
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Project;
}

/**
 * Deleting a project is irreversible and the clips it removes are real GPU
 * hours. The confirmation used to be an inline panel with no dialog role, no
 * managed focus and no Escape, so a keyboard user had to find it by tabbing and
 * had no way out that did not involve the destructive button.
 */
describe("the destructive confirmation dialog", () => {
  it("is a dialog, named by its heading and described by its body", () => {
    render(
      <ConfirmDialog open title="Delete “Harbour Lights”?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onCancel={vi.fn()}>
        <p>This cannot be undone.</p>
      </ConfirmDialog>,
    );

    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveAccessibleName("Delete “Harbour Lights”?");
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/i);
  });

  it("opens with Cancel focused, not the destructive button", async () => {
    render(
      <ConfirmDialog open title="Delete?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // One stray Enter on an auto-focused "Delete" is the whole problem.
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("commits only when the destructive button is pressed", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Delete?" confirmLabel="Delete permanently" onConfirm={onConfirm} onCancel={onCancel} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("locks both buttons while the commit is running", () => {
    render(
      <ConfirmDialog open busy busyLabel="Deleting…" title="Delete?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  });

  it("refuses Escape while a commit is already running", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open busy title="Delete?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    // The delete is already in flight; cancelling now would imply it stopped.
    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.dispatchEvent(new Event("cancel", { cancelable: true, bubbles: true }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape when nothing is running", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Delete?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.dispatchEvent(new Event("cancel", { cancelable: true, bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the delete flow on a project card", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns focus to the delete button when cancelled", async () => {
    render(<ProjectListItem project={project()} onDeleted={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Delete Harbour Lights" });
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Focus must not be dumped at the top of the document.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete Harbour Lights" })).toHaveFocus(),
    );
  });

  it("names the project in the confirmation", async () => {
    render(<ProjectListItem project={project()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Harbour Lights" }));

    expect(screen.getByRole("dialog", { hidden: true })).toHaveAccessibleName(
      /Delete .Harbour Lights/,
    );
  });

  it("returns focus to the rename button when rename is abandoned", async () => {
    render(<ProjectListItem project={project()} onDeleted={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Rename Harbour Lights" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename Harbour Lights" })).toHaveFocus(),
    );
  });

  it("keeps the row actions reachable without hover", () => {
    render(<ProjectListItem project={project()} onDeleted={vi.fn()} />);

    // No hover exists on touch, so these must not be hidden behind it.
    for (const name of ["Rename Harbour Lights", "Copy Harbour Lights", "Delete Harbour Lights"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
  });
});

describe("the shared async status region", () => {
  function Harness({ messages }: { messages: string[] }) {
    const [i, setI] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setI((n) => n + 1)}>
          next
        </button>
        <AsyncStatus message={messages[i] ?? null} busy={i === 0} />
      </>
    );
  }

  it("says nothing until there is something to say", () => {
    render(<AsyncStatus message={null} />);
    expect(screen.queryByTestId("async-status")).toBeNull();
  });

  it("is a polite status while work is running", () => {
    render(<AsyncStatus message="Running 2 of 5…" busy />);
    const region = screen.getByTestId("async-status");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-busy", "true");
  });

  it("interrupts for a failure", () => {
    render(<AsyncStatus message="Director failed" failed />);
    const region = screen.getByTestId("async-status");
    expect(region).toHaveAttribute("role", "alert");
    expect(region).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a phase change, not every repeat of the same message", async () => {
    render(<Harness messages={["Running 1 of 5…", "Running 1 of 5…", "Run complete"]} />);
    expect(screen.getByTestId("async-status")).toHaveTextContent("Running 1 of 5…");

    // The poll repeats itself; the region must not re-announce.
    await userEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByTestId("async-status")).toHaveTextContent("Running 1 of 5…");

    await userEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByTestId("async-status")).toHaveTextContent("Run complete");
  });

  it("carries its meaning in text rather than colour", () => {
    render(<AsyncStatus message="Director failed" failed />);
    expect(screen.getByTestId("async-status").textContent).toBe("Director failed");
  });
});
