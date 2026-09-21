import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScenePromptsPanel } from "@/components/storyboard/scene-prompts-panel";
import { SceneCardEditor } from "@/components/storyboard/scene-card-editor";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Both panels seed their draft once at mount, which is right for typing and
 * wrong for everything else: editing the scene card offers to rewrite the
 * prompts, and regenerating the storyboard replaces both. Without a sync the
 * panel keeps showing text that is no longer stored, and the only way to see
 * the new version is to reload the page.
 */

function sceneWith(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene-1",
    projectId: "p1",
    sceneNumber: 1,
    title: "The Ritual",
    sceneObjective: "Establish the game",
    storyBeat: "Men toss cards",
    visualDescription: "A wide shot of a dining room",
    actionDescription: "The men's hands toss cards",
    cameraMovement: "Static wide shot",
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    transitionIn: "Cut",
    transitionOut: "Cut",
    status: "planned",
    prompts: {
      startFramePrompt: "the old start prompt",
      endFramePrompt: "the old end prompt",
      videoPromptSegment: "the old video prompt",
      videoNegativePrompt: "",
      imageNegativePrompt: "",
      promptQualityChecklist: [],
    },
    ...overrides,
  } as Scene;
}

describe("prompts rewritten while the panel is open", () => {
  it("shows the new text without a reload", () => {
    const scene = sceneWith();
    const { rerender } = render(<ScenePromptsPanel scene={scene} projectId="p1" />);
    expect(screen.getByDisplayValue("the old start prompt")).toBeTruthy();

    const rewritten = sceneWith({
      prompts: { ...scene.prompts, startFramePrompt: "four men around the table" },
    });
    rerender(<ScenePromptsPanel scene={rewritten} projectId="p1" />);

    expect(screen.getByDisplayValue("four men around the table")).toBeTruthy();
    expect(screen.queryByDisplayValue("the old start prompt")).toBeNull();
  });

  /** Someone mid-sentence must not have it taken away by a background update. */
  it("keeps unsaved edits rather than overwriting them", () => {
    const scene = sceneWith();
    const { rerender } = render(<ScenePromptsPanel scene={scene} projectId="p1" />);

    const box = screen.getByDisplayValue("the old start prompt");
    fireEvent.change(box, { target: { value: "something I typed" } });

    rerender(
      <ScenePromptsPanel
        scene={sceneWith({
          prompts: { ...scene.prompts, endFramePrompt: "a rewritten end frame" },
        })}
        projectId="p1"
      />,
    );

    expect(screen.getByDisplayValue("something I typed")).toBeTruthy();
  });
});

describe("the card replaced while its editor is open", () => {
  it("shows the new card without a reload", () => {
    const { rerender } = render(<SceneCardEditor scene={sceneWith()} projectId="p1" />);
    expect(screen.getByDisplayValue("The men's hands toss cards")).toBeTruthy();

    rerender(
      <SceneCardEditor
        scene={sceneWith({ actionDescription: "Four men sit around the table" })}
        projectId="p1"
      />,
    );

    expect(screen.getByDisplayValue("Four men sit around the table")).toBeTruthy();
  });
});

/**
 * One unsaved box used to freeze every other box in the same panel.
 *
 * `synced` advanced to the stored text while `draft` kept the old copy, so the
 * panel believed it was in step while showing text the storyboard had already
 * replaced — and, because every save sent all five fields, wrote that stale
 * copy back over the replacement. A hand-edited prompt therefore came back as
 * the text it had replaced, having reported itself saved.
 */
describe("a field nobody has touched", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch() {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const bodyOf = (call: unknown[]) =>
    JSON.parse(String((call[1] as RequestInit).body)) as Record<string, string>;

  it("still follows the stored text while its neighbour is being edited", () => {
    const scene = sceneWith();
    const { rerender } = render(<ScenePromptsPanel scene={scene} projectId="p1" />);

    fireEvent.change(screen.getByDisplayValue("the old start prompt"), {
      target: { value: "something I typed" },
    });

    rerender(
      <ScenePromptsPanel
        scene={sceneWith({
          prompts: { ...scene.prompts, endFramePrompt: "a rewritten end frame" },
        })}
        projectId="p1"
      />,
    );

    expect(screen.getByDisplayValue("something I typed")).toBeTruthy();
    expect(screen.getByDisplayValue("a rewritten end frame")).toBeTruthy();
  });

  it("is not sent when another prompt is saved", async () => {
    const fetchMock = mockFetch();
    render(<ScenePromptsPanel scene={sceneWith()} projectId="p1" />);

    fireEvent.change(screen.getByDisplayValue("the old end prompt"), {
      target: { value: "a corrected end frame" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save prompts/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      endFramePrompt: "a corrected end frame",
    });
  });

  /** The reported bug, end to end: the rewritten prompt must survive the save. */
  it("is not written back stale after it was replaced underneath the panel", async () => {
    const fetchMock = mockFetch();
    const scene = sceneWith();
    const { rerender } = render(<ScenePromptsPanel scene={scene} projectId="p1" />);

    // An edit in progress is what used to strand every other field.
    fireEvent.change(screen.getByDisplayValue("the old start prompt"), {
      target: { value: "something I typed" },
    });

    rerender(
      <ScenePromptsPanel
        scene={sceneWith({
          prompts: { ...scene.prompts, endFramePrompt: "a rewritten end frame" },
        })}
        projectId="p1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save prompts/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body).toEqual({ startFramePrompt: "something I typed" });
    expect(body.endFramePrompt).toBeUndefined();
  });

  it("applies to the scene card as well", async () => {
    const fetchMock = mockFetch();
    const { rerender } = render(<SceneCardEditor scene={sceneWith()} projectId="p1" />);

    fireEvent.change(screen.getByDisplayValue("Establish the game"), {
      target: { value: "a corrected objective" },
    });

    rerender(
      <SceneCardEditor
        scene={sceneWith({ actionDescription: "Four men sit around the table" })}
        projectId="p1"
      />,
    );

    expect(screen.getByDisplayValue("a corrected objective")).toBeTruthy();
    expect(screen.getByDisplayValue("Four men sit around the table")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /save card only/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body).toEqual({ sceneObjective: "a corrected objective" });
    expect(body.actionDescription).toBeUndefined();
  });
});
