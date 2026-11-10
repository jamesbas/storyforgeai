import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SceneFeedbackPanel } from "@/components/storyboard/scene-feedback-panel";
import { SceneCard } from "@/components/storyboard/scene-card";
import { sceneSchema, type ProjectRecord, type Scene } from "@/lib/schemas/storyboard";
import type { SceneFeedbackPreview } from "@/lib/schemas/scene-feedback";

const scene: Scene = sceneSchema.parse({
  id: "s1", projectId: "p1", sceneNumber: 1,
  startTimeSeconds: 0, endTimeSeconds: 10, targetDurationSeconds: 10,
  title: "The cup", sceneObjective: "Pick up the cup", storyBeat: "Mara decides",
  visualDescription: "Mara at a table", actionDescription: "Mara picks up a cup",
  cameraMovement: "Static", transitionIn: "Cut", transitionOut: "Cut",
  status: "planned",
  prompts: {
    startFramePrompt: "Medium shot. Mara at the table.",
    endFramePrompt: "Medium shot. The cup is on the table.",
    endFrameEditPrompt: "Edit the supplied reference frame. Keep the cup on the table.",
    imageNegativePrompt: "", videoPromptSegment: "Mara raises her right hand.",
    videoNegativePrompt: "", videoPromptFamily: "wan",
  },
});

const preview: SceneFeedbackPreview = {
  sceneId: "s1", scope: "end", sourceHash: "a".repeat(64),
  proposal: {
    summary: "Move the cup into Mara's left hand.",
    revisions: [
      { field: "endFramePrompt", after: "Medium shot. Mara holds the cup in her left hand.", reason: "Correct the cup." },
      { field: "videoPromptSegment", after: "Mara picks up the cup with her left hand.", reason: "Reach the new end state." },
    ],
    videoReview: { needsChange: true, explanation: "The existing motion used the wrong hand." },
  },
  changes: [
    { sceneId: "s1", sceneNumber: 1, field: "endFramePrompt", before: scene.prompts.endFramePrompt,
      after: "Medium shot. Mara holds the cup in her left hand.", reason: "Correct the cup." },
    { sceneId: "s1", sceneNumber: 1, field: "videoPromptSegment", before: scene.prompts.videoPromptSegment,
      after: "Mara picks up the cup with her left hand.", reason: "Reach the new end state." },
    { sceneId: "s2", sceneNumber: 2, field: "startFramePrompt", before: scene.prompts.endFramePrompt,
      after: "Medium shot. Mara holds the cup in her left hand.", reason: "Carry the closing state.", carried: true },
  ],
  warnings: ["Scene 1: feedback differs from the original action."],
};

afterEach(() => vi.unstubAllGlobals());

function panel(extra: Partial<Parameters<typeof SceneFeedbackPanel>[0]> = {}) {
  const props = { scene, projectId: "p1", onSaved: vi.fn(), onBusyChange: vi.fn(), ...extra };
  const result = render(<SceneFeedbackPanel {...props} />);
  fireEvent.click(screen.getByText("Refine with feedback"));
  return { ...result, props };
}

function enterFeedback() {
  fireEvent.change(screen.getByLabelText("Feedback target"), { target: { value: "end" } });
  fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "Put the cup in her left hand." } });
}

function stubFetch() {
  const updated = { project: { id: "p1" }, storyboard: { scenes: [scene] } } as ProjectRecord;
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method === "PUT" ? updated : preview), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, updated };
}

describe("scene feedback workflow", () => {
  it("sits on a project-backed scene card without replacing scene checks or manual editing", () => {
    render(<SceneCard scene={scene} projectId="p1" checkPanel={<div>Scene check fixture</div>} />);
    expect(screen.getByText("Refine with feedback")).toBeInTheDocument();
    expect(screen.getByText("Scene check fixture")).toBeInTheDocument();
    expect(screen.getByTestId("scene-feedback-panel")).toBeInTheDocument();
  });

  it("offers all four scopes, requires nonempty feedback, and never calls the model automatically", () => {
    const { fetchMock } = stubFetch();
    panel();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Uses saved prompts/)).toBeInTheDocument();
  });

  it("shows all proposed and carried changes, the video-impact explanation and warnings before any save", async () => {
    const { fetchMock } = stubFetch();
    const { props } = panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const box = await screen.findByTestId("scene-feedback-preview");
    expect(box).toHaveTextContent("Scene 1: End keyframe");
    expect(box).toHaveTextContent("Scene 1: Video motion");
    expect(box).toHaveTextContent("Scene 2: Start keyframe (carried opening)");
    expect(box).toHaveTextContent("The existing motion used the wrong hand.");
    expect(box).toHaveTextContent("feedback differs from the original action");
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(vi.mocked(props.onBusyChange).mock.calls).toEqual([[true], [false]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/projects/p1/scenes/s1/feedback");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      scope: "end", feedback: "Put the cup in her left hand.",
    });
  });

  it("accepts the complete proposal once and leaves regeneration manual", async () => {
    const { fetchMock, updated } = stubFetch();
    const { props } = panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByTestId("scene-feedback-preview");
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(updated));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      scope: "end", sourceHash: preview.sourceHash, proposal: preview.proposal,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Existing media is unchanged");
    expect(screen.queryByTestId("scene-feedback-preview")).toBeNull();
  });

  it("discards the preview without saving and keeps the feedback available to refine", async () => {
    const { fetchMock } = stubFetch();
    panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByTestId("scene-feedback-preview");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("scene-feedback-preview")).toBeNull();
    expect(screen.getByLabelText("What should change?")).toHaveValue("Put the cup in her left hand.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the preview when feedback or scope changes", async () => {
    stubFetch();
    panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByTestId("scene-feedback-preview");
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "Use the right hand instead." } });
    expect(screen.queryByTestId("scene-feedback-preview")).toBeNull();
  });

  it("does not allow accepting a preview after the scene props change", async () => {
    stubFetch();
    const { rerender, props } = panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByTestId("scene-feedback-preview");
    rerender(<SceneFeedbackPanel {...props} scene={{ ...scene, prompts: { ...scene.prompts, startFramePrompt: "A new opening." } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("changed after the preview");
    expect(screen.getByRole("button", { name: "Accept changes" })).toBeDisabled();
  });

  it("shows server errors without pretending anything was saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "LM Studio is unavailable." }), { status: 409 })));
    const { props } = panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LM Studio is unavailable.");
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("preserves the preview when applying fails so it can be read or discarded", async () => {
    const { fetchMock } = stubFetch();
    const { props } = panel();
    enterFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByTestId("scene-feedback-preview");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Preview again before applying; nothing was saved." }), { status: 409 }));
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was saved");
    expect(screen.getByTestId("scene-feedback-preview")).toBeInTheDocument();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("disables video-only feedback for a keyframes-only scene and disables controls while busy", () => {
    const { rerender, props } = panel({ rendersVideo: false });
    expect(screen.getByRole("option", { name: "Video prompt only" })).toBeDisabled();
    rerender(<SceneFeedbackPanel {...props} busy />);
    expect(screen.getByLabelText("Feedback target")).toBeDisabled();
    expect(screen.getByLabelText("What should change?")).toBeDisabled();
  });
});
