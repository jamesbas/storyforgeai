import { describe, it, expect } from "vitest";
import {
  canTransition,
  deriveTaskState,
  reconcileState,
  summarise,
  transition,
  TaskTransitionError,
} from "@/lib/tasks/state-machine";
import { MAX_HISTORY_PER_ENTRY, isActive, isTerminal, needsOperator, type TaskEntry } from "@/lib/schemas/tasks";

function entry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: "e1",
    ref: "p1-scene-001",
    label: "Scene 1",
    order: 1,
    state: "pending",
    attempts: 0,
    history: [],
    ...overrides,
  };
}

describe("state classification", () => {
  it("treats only finished states as terminal", () => {
    for (const state of ["completed", "failed", "cancelled", "stop_tracking"] as const) {
      expect(isTerminal(state), state).toBe(true);
    }
    for (const state of ["pending", "running", "submitting", "interrupted"] as const) {
      expect(isTerminal(state), state).toBe(false);
    }
  });

  it("marks the two states that need a human", () => {
    expect(needsOperator("interrupted")).toBe(true);
    expect(needsOperator("submission_unknown")).toBe(true);
    expect(needsOperator("failed")).toBe(false);
  });

  it("does not count work awaiting a decision as active", () => {
    // It is not progressing, so a drainer must not pick it up.
    expect(isActive("submission_unknown")).toBe(false);
    expect(isActive("running")).toBe(true);
  });
});

/**
 * The rule the whole spec turns on: nothing that might have a live backend job
 * may return to `pending`, because WanGP generation is not idempotent.
 */
describe("permitted transitions", () => {
  it("allows the happy path", () => {
    expect(canTransition("pending", "submitting")).toBe(true);
    expect(canTransition("submitting", "submitted")).toBe(true);
    expect(canTransition("submitted", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
  });

  it("refuses to send an in-flight entry back to pending", () => {
    for (const from of ["submitting", "submitted", "running", "interrupted", "submission_unknown"] as const) {
      expect(canTransition(from, "pending"), from).toBe(false);
    }
  });

  it("allows pending only through a deliberate retry", () => {
    expect(canTransition("failed", "pending")).toBe(false);
    expect(canTransition("failed", "retry_pending")).toBe(true);
    expect(canTransition("retry_pending", "pending")).toBe(true);
  });

  it("lets nothing leave a terminal state except a retry from failed", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("cancelled", "pending")).toBe(false);
    expect(canTransition("stop_tracking", "running")).toBe(false);
  });

  it("throws rather than silently ignoring an illegal move", () => {
    expect(() => transition(entry({ state: "completed" }), "running")).toThrow(TaskTransitionError);
  });
});

describe("applying a transition", () => {
  it("records history with both ends of the move", () => {
    const moved = transition(entry(), "submitting", { detail: "about to submit" });
    expect(moved.history).toHaveLength(1);
    expect(moved.history[0]).toMatchObject({ from: "pending", to: "submitting" });
  });

  it("bounds history so a retry loop cannot grow an entry without limit", () => {
    let current = entry({ state: "failed" });
    for (let i = 0; i < 30; i += 1) {
      current = transition(current, "retry_pending");
      current = transition(current, "pending");
      current = transition(current, "failed");
    }
    expect(current.history.length).toBeLessThanOrEqual(MAX_HISTORY_PER_ENTRY);
  });

  it("stamps startedAt once, on the first run", () => {
    const running = transition(entry({ state: "submitted", startedAt: "2020-01-01T00:00:00.000Z" }), "running");
    expect(running.startedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("stamps finishedAt when it reaches a terminal state", () => {
    expect(transition(entry({ state: "running" }), "completed").finishedAt).toBeDefined();
  });

  it("persists the external job id the moment it is known", () => {
    const submitted = transition(entry({ state: "submitting" }), "submitted", {
      externalJobId: "wangp-123",
    });
    expect(submitted.externalJobId).toBe("wangp-123");
  });

  it("keeps the failure reason on the entry", () => {
    expect(transition(entry({ state: "running" }), "failed", { detail: "CUDA fault" }).error).toBe(
      "CUDA fault",
    );
  });

  it("truncates a long diagnostic rather than storing it whole", () => {
    const huge = "x".repeat(5000);
    const failed = transition(entry({ state: "running" }), "failed", { detail: huge });
    expect(failed.error!.length).toBeLessThanOrEqual(220);
  });

  it("clears the old failure when a retry starts", () => {
    const failed = transition(entry({ state: "running" }), "failed", { detail: "boom" });
    const staged = transition(failed, "retry_pending");
    const retried = transition(staged, "pending");
    expect(retried.error).toBeUndefined();
    expect(retried.finishedAt).toBeUndefined();
    // The diagnosis survives in history even though the field was cleared.
    expect(retried.history.some((h) => h.detail === "boom")).toBe(true);
  });
});

/** FR-3, FR-5, FR-11 — what a restart does with work left mid-flight. */
describe("restart reconciliation", () => {
  it("never auto-resubmits an entry caught mid-submission", () => {
    // The backend may already have accepted it; resubmitting burns GPU minutes
    // on a duplicate.
    expect(reconcileState(entry({ state: "submitting" }))).toBe("submission_unknown");
  });

  it("still refuses when a submitting entry somehow has a job id", () => {
    expect(reconcileState(entry({ state: "submitting", externalJobId: "wangp-9" }))).toBe(
      "submission_unknown",
    );
  });

  it("polls a running entry that has a job id", () => {
    expect(reconcileState(entry({ state: "running", externalJobId: "wangp-1" }))).toBe(
      "reconciling",
    );
  });

  it("interrupts a running entry with nothing to poll", () => {
    expect(reconcileState(entry({ state: "running" }))).toBe("interrupted");
  });

  it("leaves work that never started alone", () => {
    expect(reconcileState(entry({ state: "pending" }))).toBeNull();
    expect(reconcileState(entry({ state: "retry_pending" }))).toBeNull();
  });

  it("leaves finished work alone", () => {
    for (const state of ["completed", "failed", "cancelled", "stop_tracking"] as const) {
      expect(reconcileState(entry({ state })), state).toBeNull();
    }
  });

  it("retries a reconcile that was itself interrupted", () => {
    expect(reconcileState(entry({ state: "reconciling", externalJobId: "w1" }))).toBe("reconciling");
    expect(reconcileState(entry({ state: "reconciling" }))).toBe("interrupted");
  });
});

describe("deriving the task state from its entries", () => {
  it("reports interrupted when anything needs a human, even beside failures", () => {
    const state = deriveTaskState([
      entry({ state: "completed" }),
      entry({ state: "failed" }),
      entry({ state: "submission_unknown" }),
    ]);
    expect(state).toBe("interrupted");
  });

  it("reports running while any work is outstanding", () => {
    expect(deriveTaskState([entry({ state: "completed" }), entry({ state: "pending" })])).toBe(
      "running",
    );
  });

  it("surfaces a pending cancellation", () => {
    expect(deriveTaskState([entry({ state: "cancel_requested" })])).toBe("cancel_requested");
  });

  it("reports failed only once nothing is left to do", () => {
    expect(deriveTaskState([entry({ state: "completed" }), entry({ state: "failed" })])).toBe(
      "failed",
    );
  });

  it("reports cancelled when every entry was cancelled", () => {
    expect(deriveTaskState([entry({ state: "cancelled" }), entry({ state: "cancelled" })])).toBe(
      "cancelled",
    );
  });

  it("reports completed for an empty task", () => {
    expect(deriveTaskState([])).toBe("completed");
  });
});

describe("summarising for the recovery panel", () => {
  it("counts each category separately", () => {
    const counts = summarise([
      entry({ state: "completed" }),
      entry({ state: "completed" }),
      entry({ state: "failed" }),
      entry({ state: "running" }),
      entry({ state: "interrupted" }),
    ]);
    expect(counts).toEqual({ total: 5, active: 1, completed: 2, failed: 1, needsOperator: 1 });
  });
});
