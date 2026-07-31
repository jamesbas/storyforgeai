import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgenticCanvas } from "@/components/agentic-canvas/agentic-canvas";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Recovering a run that outlived the screen that started it.
 *
 * Run state used to live in component state, so leaving a page mid-run and
 * coming back showed an idle screen with every button unlocked — inviting a
 * second run onto a model already working on the first. Both the canvas and
 * the storyboard screen now read the truth back from the server.
 */

const record: ProjectRecord = {
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

/** Answers the project fetch and the agent-run poll differently. */
function stubFetch(run: { agentKey: string; agentName: string } | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/agent-run") ? { run } : record),
    })) as unknown as typeof fetch,
  );
}

describe("recovering an agent run the screen did not start", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("leaves the canvas alone when nothing is running", async () => {
    stubFetch(null);
    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
    expect(screen.queryByTestId("canvas-remote-run")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run core agents/i })).not.toBeDisabled();
  });

  it("names the running agent and locks the buttons", async () => {
    stubFetch({ agentKey: "director", agentName: "Director" });
    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId("canvas-remote-run")).toBeInTheDocument());
    expect(screen.getByTestId("canvas-remote-run")).toHaveTextContent(/Director is still running/);
    expect(screen.getByRole("button", { name: /run core agents/i })).toBeDisabled();
  });

  /** The card for the running agent is the one that should say so. */
  it("marks the running agent's own card", async () => {
    stubFetch({ agentKey: "world", agentName: "World Builder" });
    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByText("Running…")).toHaveLength(1));
  });
});
