import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariantReview } from "@/components/agentic-canvas/variant-review";
import { AgenticCanvas } from "@/components/agentic-canvas/agentic-canvas";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import type { CanvasRunEntry, CanvasRunState } from "@/lib/services/canvas-queue";

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

const variant = (id: string, selected = false): CreativeVariant => ({
  id,
  projectId: "p1",
  name: `Direction ${id}`,
  variantType: "concept",
  summary: "A distinct creative direction.",
  strengths: ["clear POV"],
  risks: ["execution"],
  selected,
  createdByAgent: "Variant Explorer",
  createdAt: new Date().toISOString(),
});

const baseRecord: ProjectRecord = {
  project: {
    id: "p1",
    title: "Demo",
    concept: "x",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: 3,
    generatedDurationSeconds: 60,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

describe("VariantReview component", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders three variant cards when the record has variants", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [variant("1"), variant("2"), variant("3")],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("variant-card")).toHaveLength(3));
  });

  it("shows an empty state before variants are generated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(baseRecord)));
    render(<VariantReview projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/no variants yet/i)).toBeInTheDocument());
  });

  it("labels the three axes distinctly and says what each one holds still", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [
        { ...variant("1"), variantType: "story" },
        { ...variant("2"), variantType: "hook" },
        { ...variant("3"), variantType: "visual_style" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("variant-card")).toHaveLength(3));

    for (const label of ["different story", "different opening", "different look"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const changes = screen.getAllByTestId("variant-changes").map((el) => el.textContent);
    expect(new Set(changes).size).toBe(3);
  });

  it("still reads a legacy set where every direction was labelled concept", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [variant("1"), variant("2"), variant("3")],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("variant-card")).toHaveLength(3));
    expect(screen.getAllByText("different premise")).toHaveLength(3);
  });

  it("says a legacy set has no provenance rather than implying a model wrote it", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [variant("1"), variant("2"), variant("3")],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId("variant-provenance")).toBeInTheDocument());
    expect(screen.getByTestId("execution-badge")).toHaveTextContent(
      "No provenance (legacy project)",
    );
  });

  it("shows a repaired set as hybrid and explains what was filled in", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [
        { ...variant("1"), variantType: "story" },
        { ...variant("2"), variantType: "hook" },
        { ...variant("3"), variantType: "visual_style" },
      ],
      executions: [
        {
          executionId: "x1",
          artifact: "variants",
          source: "hybrid",
          status: "degraded",
          fallbackReason: "invalid_set",
          attempted: { total: 3, fromLlm: 1 },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5,
        },
      ],
    } as unknown as ProjectRecord;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("execution-badge")).toHaveTextContent("Hybrid · 1/3 from the model"),
    );
    expect(screen.getByTestId("variant-provenance")).toHaveTextContent(/repeated an axis/i);
  });

  it("does not call demo mode a failure", async () => {
    const record: ProjectRecord = {
      ...baseRecord,
      variants: [variant("1"), variant("2"), variant("3")],
      executions: [
        {
          executionId: "x2",
          artifact: "variants",
          source: "deterministic",
          status: "ok",
          fallbackReason: "provider_disabled",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5,
        },
      ],
    } as unknown as ProjectRecord;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(record)));

    render(<VariantReview projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("execution-badge")).toHaveTextContent("Deterministic"),
    );
    expect(screen.getByTestId("variant-provenance").textContent).not.toMatch(
      /failed|could not|wrong shape/i,
    );
  });
});

describe("AgenticCanvas component", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders one card per creative agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(baseRecord)));
    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
  });
});

// ---------------------------------------------------------------------------
// Canvas queue reconciliation (SPEC-002)
// ---------------------------------------------------------------------------

type QueueSnapshot = { entries: CanvasRunEntry[]; active: boolean; done: number; total: number };

const CORE = [
  ["world", "World Builder"],
  ["director", "Director"],
  ["cinematographer", "Cinematographer"],
  ["art", "Art Director"],
] as const;

function entry(
  index: number,
  state: CanvasRunState,
  finishedAt = `2026-08-02T10:00:0${index}.000Z`,
): CanvasRunEntry {
  return {
    projectId: "p1",
    agentKey: CORE[index]![0],
    agentName: CORE[index]![1],
    state,
    ...(state === "pending" || state === "running" ? {} : { finishedAt }),
  };
}

function snapshot(states: CanvasRunState[], finishedAtSuffix = ""): QueueSnapshot {
  const entries = states.map((state, i) =>
    entry(i, state, `2026-08-02T10:00:0${i}.00${finishedAtSuffix || "0"}Z`),
  );
  return {
    entries,
    active: entries.some((e) => e.state === "pending" || e.state === "running"),
    done: entries.filter((e) => e.state === "completed").length,
    total: entries.length,
  };
}

const IDLE: QueueSnapshot = { entries: [], active: false, done: 0, total: 0 };

/** A record whose four core plans exist, so the cards read "ready". */
const plannedRecord: ProjectRecord = {
  ...baseRecord,
  worldBible: { premise: "A drowned city keeps its lights on." },
  directorialPlan: { creativeThesis: "Hold on faces." },
  cinematographyPlan: { cameraLanguage: "Long lenses, slow moves.", sceneShotPlans: {} },
  artDirectionPlan: { productionDesign: "Wet concrete and sodium light." },
} as unknown as ProjectRecord;

/**
 * A fake server for the three endpoints the canvas polls. `projectFetches`
 * counts reconciliations, which is what deduplication is measured on.
 */
function server(initial: { record: ProjectRecord; queue: QueueSnapshot }) {
  const state = {
    record: initial.record,
    queue: initial.queue,
    projectFetches: 0,
    onPost: undefined as undefined | (() => void),
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/canvas-run")) {
      if (init?.method === "POST") state.onPost?.();
      return jsonResponse(state.queue);
    }
    if (url.endsWith("/agent-run")) return jsonResponse({ run: null });
    state.projectFetches += 1;
    return jsonResponse(state.record);
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

describe("AgenticCanvas queue reconciliation", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("reloads once when the enqueue response is already terminal", async () => {
    const state = server({ record: baseRecord, queue: IDLE });
    // The deterministic queue finishes inside the POST, before any poll runs.
    state.onPost = () => {
      state.queue = snapshot(["completed", "completed", "completed", "completed"]);
      state.record = plannedRecord;
    };

    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
    expect(state.projectFetches).toBe(1);
    expect(screen.queryAllByText("ready")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /run core agents/i }));

    // No refresh, no further poll: the cards converge from the POST response.
    await waitFor(() => expect(screen.getAllByText("ready")).toHaveLength(4));
    expect(state.projectFetches).toBe(2);
    expect(screen.getByTestId("canvas-queue-complete")).toHaveTextContent(
      "Run complete — 4 of 4 agents finished.",
    );
    expect(screen.getByRole("button", { name: /run core agents/i })).toBeEnabled();
  });

  it("keeps slow-run progress and reconciles each snapshot exactly once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = server({
      record: baseRecord,
      queue: snapshot(["running", "pending", "pending", "pending"]),
    });

    render(<AgenticCanvas projectId="p1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("canvas-queue-running")).toBeInTheDocument();
    expect(state.projectFetches).toBe(1);

    // One agent finishes: one reload.
    state.queue = snapshot(["completed", "running", "pending", "pending"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(state.projectFetches).toBe(2);

    // The same snapshot polled again must not reconcile a second time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(state.projectFetches).toBe(2);

    // The run ends: exactly one final reload.
    state.queue = snapshot(["completed", "completed", "completed", "completed"]);
    state.record = plannedRecord;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(state.projectFetches).toBe(3);
    await waitFor(() => expect(screen.getAllByText("ready")).toHaveLength(4));
    expect(screen.queryByTestId("canvas-queue-running")).toBeNull();

    // Idle cadence backs off and nothing reloads on repeat terminal polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(state.projectFetches).toBe(3);
  });

  /**
   * The Storyboard Artist ran for twenty-four minutes behind a label that never
   * moved, next to a card reading "pending". Both were accurate and together
   * they read as a hang.
   */
  it("says which sub-step a long agent is on, and calls it running rather than pending", async () => {
    const storyboardEntry: CanvasRunEntry = {
      projectId: "p1",
      agentKey: "storyboard",
      agentName: "Storyboard Artist",
      state: "running",
      progress: { phase: "Writing prompts", done: 2, total: 3 },
    };
    server({
      record: plannedRecord,
      queue: {
        entries: [...(["completed", "completed", "completed", "completed"] as CanvasRunState[]).map(
          (state, i) => entry(i, state),
        ), storyboardEntry],
        active: true,
        done: 4,
        total: 5,
      },
    });

    render(<AgenticCanvas projectId="p1" />);

    await waitFor(() =>
      expect(screen.getByTestId("canvas-run-status")).toHaveTextContent(
        "Running Storyboard Artist — Writing prompts, scene 2 of 3. 4 of 5 done.",
      ),
    );
    expect(screen.getByTestId("agent-progress")).toHaveTextContent("Writing prompts, scene 2 of 3");
    // "Running 5 of 5" read as though all five had finished.
    expect(screen.getByRole("button", { name: /running step 5 of 5/i })).toBeInTheDocument();
  });

  it("keeps the plain sentence for an agent that reports no sub-step", async () => {
    server({
      record: baseRecord,
      queue: snapshot(["running", "pending", "pending", "pending"]),
    });

    render(<AgenticCanvas projectId="p1" />);

    await waitFor(() =>
      expect(screen.getByTestId("canvas-run-status")).toHaveTextContent(
        "Running World Builder, 0 of 4 done.",
      ),
    );
    expect(screen.queryByTestId("agent-progress")).toBeNull();
  });

  it("names the failed agent and keeps completed predecessors", async () => {
    const state = server({ record: baseRecord, queue: IDLE });
    state.onPost = () => {
      const failing = snapshot(["completed", "failed", "cancelled", "cancelled"]);
      failing.entries[1]!.error = "director exploded";
      state.queue = failing;
      state.record = { ...baseRecord, worldBible: plannedRecord.worldBible } as ProjectRecord;
    };

    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
    await userEvent.click(screen.getByRole("button", { name: /run core agents/i }));

    await waitFor(() =>
      expect(screen.getByTestId("canvas-queue-failed")).toHaveTextContent(/director exploded/i),
    );
    expect(screen.getByTestId("canvas-queue-failed")).toHaveTextContent(/Director failed/);
    // The predecessor's artifact survived the failed run.
    expect(screen.getAllByText("ready")).toHaveLength(1);
    expect(screen.queryByTestId("canvas-queue-complete")).toBeNull();
    expect(state.projectFetches).toBe(2);
  });

  it("reports a cancelled run as a completion state", async () => {
    const state = server({ record: baseRecord, queue: IDLE });
    state.onPost = () => {
      state.queue = snapshot(["completed", "cancelled", "cancelled", "cancelled"]);
      state.record = { ...baseRecord, worldBible: plannedRecord.worldBible } as ProjectRecord;
    };

    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
    await userEvent.click(screen.getByRole("button", { name: /run core agents/i }));

    await waitFor(() =>
      expect(screen.getByTestId("canvas-queue-complete")).toHaveTextContent(
        "Stopped after World Builder; 3 remaining cancelled.",
      ),
    );
  });

  it("clears the previous terminal display when a second run starts", async () => {
    const state = server({ record: baseRecord, queue: IDLE });
    state.onPost = () => {
      state.queue = snapshot(["completed", "completed", "completed", "completed"]);
      state.record = plannedRecord;
    };

    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
    await userEvent.click(screen.getByRole("button", { name: /run core agents/i }));
    await waitFor(() => expect(screen.getByTestId("canvas-queue-complete")).toBeInTheDocument());

    // Second run: the queue is cleared and re-enqueued server-side.
    state.onPost = () => {
      state.queue = snapshot(["running", "pending", "pending", "pending"]);
    };
    await userEvent.click(screen.getByRole("button", { name: /run core agents/i }));

    await waitFor(() => expect(screen.getByTestId("canvas-queue-running")).toBeInTheDocument());
    expect(screen.queryByTestId("canvas-queue-complete")).toBeNull();
    // Artifacts from the first run are still on screen.
    expect(screen.getAllByText("ready")).toHaveLength(4);
  });
});
