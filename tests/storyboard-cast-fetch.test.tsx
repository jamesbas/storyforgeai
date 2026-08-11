import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StoryboardView } from "@/components/storyboard/storyboard-view";
import { sceneSchema } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * The cast fetch feeds every piece of wardrobe UI on this screen.
 *
 * `/api/characters` answers `{ characters: [...] }`, but the view cast the body
 * straight to an array and called `.map` on it. The TypeError landed in a catch
 * written for a network failure, so the cast stayed empty and both the
 * undressed-scene warning and the per-scene wardrobe fields simply never
 * appeared — with nothing anywhere to say why.
 */

const scene = (sceneNumber: number, actionDescription: string) =>
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
    actionDescription,
    cameraMovement: "static",
    transitionIn: "cut",
    transitionOut: "cut",
    charactersPresent: ["Tracey"],
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
    requestedDurationSeconds: 20,
    segmentSeconds: 20,
    segmentCount: 1,
    generatedDurationSeconds: 20,
    finalTrimSeconds: 0,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "erotic art film",
    tone: "erotic",
    audience: "adults only, explicit content",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    useCharacterLibrary: true,
    characterIds: ["c-tracey"],
    characterWardrobe: { "c-tracey": "a black silk slip" },
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  storyboard: {
    brief: {} as never,
    visualBible: {} as never,
    scenes: [scene(1, "He begins performing oral sex on Tracey.")] as never,
  },
} as ProjectRecord;

const TRACEY = {
  id: "c-tracey",
  name: "Tracey",
  description: "A woman.",
  wardrobe: "blue jeans",
  referenceImagePaths: [],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/characters")
        ? { characters: [TRACEY] }
        : url === "/api/projects/p1"
          ? record
          : url.includes("/queue")
            ? { entries: [] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

describe("StoryboardView cast fetch", () => {
  it("unwraps the character list so the wardrobe UI can render", async () => {
    render(<StoryboardView projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByTestId("wardrobe-check")).toBeInTheDocument();
    });
    expect(screen.getByTestId("wardrobe-check")).toHaveTextContent(/undressed but still carry/i);
    expect(screen.getByLabelText("Tracey")).toBeInTheDocument();
  });
});
