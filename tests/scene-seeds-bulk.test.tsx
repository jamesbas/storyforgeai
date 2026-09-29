import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoryboardView } from "@/components/storyboard/storyboard-view";
import { sceneSchema } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Taking new seeds for several scenes at once.
 *
 * The per-card button was the only way, so re-rolling a 30-scene project
 * meant thirty clicks and thirty requests.
 */

const scene = (sceneNumber: number) =>
  sceneSchema.parse({
    id: `s${sceneNumber}`,
    projectId: "p1",
    sceneNumber,
    startTimeSeconds: (sceneNumber - 1) * 20,
    endTimeSeconds: sceneNumber * 20,
    targetDurationSeconds: 20,
    title: `Scene ${sceneNumber}`,
    sceneObjective: "o",
    storyBeat: "b",
    visualDescription: "v",
    actionDescription: "a",
    cameraMovement: "static",
    transitionIn: "cut",
    transitionOut: "cut",
    status: "generated",
    prompts: {
      startFramePrompt: "a",
      endFramePrompt: "b",
      videoPromptSegment: "c",
      imageNegativePrompt: "",
      videoNegativePrompt: "",
    },
  });

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
    tone: "neutral",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "video_segments",
    modelStrategy: "auto",
    sceneSeeds: { s1: 11, s2: 22, s3: 33 },
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  storyboard: {
    brief: {} as never,
    visualBible: {} as never,
    scenes: [scene(1), scene(2), scene(3)] as never,
  },
} as ProjectRecord;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      url === "/api/projects/p1/seeds" && init?.method === "DELETE"
        ? {
            record: { ...record, project: { ...record.project, sceneSeeds: { s3: 33 } } },
            cleared: ["s1", "s2"],
          }
        : url.startsWith("/api/characters")
          ? { characters: [] }
          : url === "/api/projects/p1"
            ? record
            : url.includes("/queue")
              ? { entries: [] }
              : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("new seeds for selected scenes", () => {
  it("re-rolls the ticked scenes in one request and ticks them for a keyframe rerun", async () => {
    const user = userEvent.setup();
    render(<StoryboardView projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId("seed-scene-picker")).toBeInTheDocument());
    const picker = screen.getByTestId("seed-scene-picker");
    await user.click(within(picker).getByLabelText("Scene 1"));
    await user.click(within(picker).getByLabelText("Scene 2"));
    await user.click(screen.getByTestId("new-seeds-selected"));

    await waitFor(() => expect(screen.getByTestId("new-seeds-notice")).toBeInTheDocument());
    expect(screen.getByTestId("new-seeds-notice")).toHaveTextContent("2 scenes will sample a new seed");

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
    const request = calls.filter(([url, init]) => url === "/api/projects/p1/seeds" && init?.method === "DELETE");
    expect(request).toHaveLength(1);
    expect(JSON.parse(String(request[0]![1]!.body))).toEqual({ sceneIds: ["s1", "s2"] });

    // Nothing is re-rendered, but the same scenes are waiting to be.
    const keyframes = screen.getByTestId("keyframe-scene-picker");
    expect(within(keyframes).getByLabelText("Scene 1")).toBeChecked();
    expect(within(keyframes).getByLabelText("Scene 2")).toBeChecked();
    expect(within(keyframes).getByLabelText("Scene 3")).not.toBeChecked();
  });

  it("offers Select all, so every scene can be re-rolled at once", async () => {
    const user = userEvent.setup();
    render(<StoryboardView projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId("seed-scene-picker")).toBeInTheDocument());
    await user.click(within(screen.getByTestId("seed-scene-picker")).getByText("Select all"));

    expect(screen.getByTestId("new-seeds-selected")).toHaveTextContent("New seeds for 3 scenes");
  });
});
