import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScenePromptsPanel } from "@/components/storyboard/scene-prompts-panel";
import type { Scene } from "@/lib/schemas/storyboard";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

function scene(prompts: Partial<Scene["prompts"]> = {}, overrides: Partial<Scene> = {}): Scene {
  return {
    id: "p1-scene-001",
    projectId: "p1",
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    title: "The gear",
    sceneObjective: "Seat the gear",
    storyBeat: "The apprentice commits",
    visualDescription: "Close-up of the bench",
    actionDescription: "She seats the gear",
    cameraMovement: "Slow push-in",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    status: "draft",
    prompts: {
      startFramePrompt: "Close-up, eye level. The apprentice at the bench.",
      endFramePrompt: "Close-up, eye level. The gear seated.",
      imageNegativePrompt: "watermark",
      videoPromptSegment: "She seats the gear. The camera pushes in.",
      videoNegativePrompt: "flicker",
      promptQualityChecklist: [],
      ...prompts,
    },
    ...overrides,
  } as Scene;
}

function open() {
  screen.getByText("Prompts").click();
}

/**
 * The lint exists so a problem is visible before a job is submitted, rather
 * than after minutes of GPU time come back wrong.
 */
describe("prompt lint in the panel", () => {
  it("says nothing about a clean set of prompts", () => {
    render(<ScenePromptsPanel scene={scene()} projectId="p1" />);
    open();
    expect(screen.queryByTestId("prompt-lint")).toBeNull();
  });

  it("flags an image prompt that does not open with framing", () => {
    render(
      <ScenePromptsPanel
        scene={scene({ startFramePrompt: "The apprentice leans over the bench." })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByText(/does not open with shot size and camera height/i)).toBeVisible();
  });

  it("flags a repeated sentence", () => {
    render(
      <ScenePromptsPanel
        scene={scene({ videoPromptSegment: "She turns. She turns." })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByText(/sentence is repeated/i)).toBeVisible();
  });

  it("flags a punctuation artifact", () => {
    render(
      <ScenePromptsPanel
        scene={scene({ videoPromptSegment: "Camera: push-in., then hold." })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByText(/punctuation artifact/i)).toBeVisible();
  });

  it("flags dialogue that never made it into the video prompt", () => {
    render(
      <ScenePromptsPanel
        scene={scene(
          { videoPromptSegment: "She seats the gear. The camera pushes in." },
          { dialogue: [{ character: "Ana", line: "Then we decide now." }] } as Partial<Scene>,
        )}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByText(/will not be spoken/i)).toBeVisible();
  });

  it("says nothing when the dialogue is present", () => {
    render(
      <ScenePromptsPanel
        scene={scene(
          { videoPromptSegment: 'She seats the gear. Ana says, "Then we decide now."' },
          { dialogue: [{ character: "Ana", line: "Then we decide now." }] } as Partial<Scene>,
        )}
        projectId="p1"
      />,
    );
    open();
    expect(screen.queryByText(/will not be spoken/i)).toBeNull();
  });

  it("does not lint negative prompts, which are term lists rather than prose", () => {
    render(
      <ScenePromptsPanel
        scene={scene({ imageNegativePrompt: "watermark, watermark" })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.queryByTestId("prompt-lint")).toBeNull();
  });

  it("carries its meaning in words, not colour alone", () => {
    render(
      <ScenePromptsPanel
        scene={scene({ videoPromptSegment: "She turns. She turns." })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByTestId("prompt-lint").textContent).toMatch(/^Warning:/);
  });

  it("warns without blocking the save button", () => {
    // Quality warnings are overridable; only an invalid request should block.
    render(
      <ScenePromptsPanel
        scene={scene({ videoPromptSegment: "She turns. She turns." })}
        projectId="p1"
      />,
    );
    open();
    expect(screen.getByRole("button", { name: /save prompts/i })).toBeInTheDocument();
  });
});

describe("composer provenance in the panel", () => {
  const execution: ArtifactExecution = {
    executionId: "e1",
    artifact: "p1-scene-001.image_prompt",
    source: "deterministic",
    status: "ok",
    composerVersion: "media-composer-v2",
    promptVersion: "image-prompt-v1",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
  } as ArtifactExecution;

  it("shows the composer and prompt versions beside the source badge", () => {
    render(<ScenePromptsPanel scene={scene()} projectId="p1" execution={execution} />);
    open();
    expect(screen.getByTestId("execution-badge")).toBeVisible();
    expect(screen.getByText("Composer media-composer-v2")).toBeVisible();
    expect(screen.getByText("Prompt image-prompt-v1")).toBeVisible();
  });

  it("shows nothing when a legacy project has no execution record", () => {
    render(<ScenePromptsPanel scene={scene()} projectId="p1" />);
    expect(screen.queryByTestId("execution-badge")).toBeNull();
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
