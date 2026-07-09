import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AnimaticReview } from "@/components/agentic-canvas/animatic-review";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

const recordWithAnimatic: ProjectRecord = {
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
    status: "storyboard_ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  animaticPlan: {
    projectId: "p1",
    totalDurationSeconds: 60,
    frames: [1, 2, 3].map((n) => ({
      sceneNumber: n,
      caption: `Frame ${n}`,
      durationSeconds: 20,
      transitionIn: "Cut",
      transitionOut: "Cut",
      startFramePrompt: "start",
      endFramePrompt: "end",
    })),
    sceneDurationMap: { "1": 20, "2": 20, "3": 20 },
    previewAssembled: false,
  },
};

describe("AnimaticReview component", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders one frame per animatic frame", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(recordWithAnimatic)));
    render(<AnimaticReview projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("animatic-frame")).toHaveLength(3));
    expect(screen.getByRole("button", { name: /approve animatic/i })).toBeInTheDocument();
  });
});
