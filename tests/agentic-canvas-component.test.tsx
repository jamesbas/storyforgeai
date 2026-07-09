import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { VariantReview } from "@/components/agentic-canvas/variant-review";
import { AgenticCanvas } from "@/components/agentic-canvas/agentic-canvas";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";

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
});

describe("AgenticCanvas component", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders one card per creative agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(baseRecord)));
    render(<AgenticCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("agent-card")).toHaveLength(8));
  });
});
