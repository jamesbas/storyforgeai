import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SelectedScenePromptTools } from "@/components/storyboard/selected-scene-prompt-tools";
import { rewriteOptionsFor } from "@/lib/schemas/scene-feedback";
import { sceneSchema, type ProjectRecord, type Scene } from "@/lib/schemas/storyboard";

const scene = (n: number): Scene => sceneSchema.parse({
  id: `s${n}`, projectId: "p1", sceneNumber: n,
  startTimeSeconds: 0, endTimeSeconds: 10, targetDurationSeconds: 10,
  title: `Scene ${n}`, sceneObjective: "o", storyBeat: "b",
  visualDescription: "v", actionDescription: "a",
  cameraMovement: "Static", transitionIn: "Cut", transitionOut: "Cut",
  status: "planned",
  prompts: {
    startFramePrompt: "Start.", endFramePrompt: "End.", imageNegativePrompt: "",
    videoPromptSegment: "Motion.", videoNegativePrompt: "", videoPromptFamily: "wan",
  },
});
const scenes = [scene(1), scene(2), scene(3)];

afterEach(() => vi.unstubAllGlobals());

function tools(rendersVideo = true) {
  const props = {
    projectId: "p1", scenes, rendersVideo, disabled: false, rewriting: false,
    onRewrite: vi.fn(async () => {}), onSaved: vi.fn(), onBusyChange: vi.fn(),
  };
  render(<SelectedScenePromptTools {...props} />);
  fireEvent.click(screen.getByText("Rewrite prompts for selected scenes"));
  fireEvent.click(screen.getByLabelText("Scene 1"));
  fireEvent.click(screen.getByLabelText("Scene 3"));
  return props;
}

describe("rewrite request for the ticked prompts", () => {
  it("maps targets onto passes and, for a single keyframe, frames", () => {
    expect(rewriteOptionsFor(["start", "end", "video"])).toEqual({});
    expect(rewriteOptionsFor(["start", "end"])).toEqual({ passes: ["image"] });
    expect(rewriteOptionsFor(["end"])).toEqual({ passes: ["image"], frames: ["end"] });
    expect(rewriteOptionsFor(["start", "video"])).toEqual({ passes: ["image", "video"], frames: ["start"] });
    expect(rewriteOptionsFor(["video"])).toEqual({ passes: ["video"] });
  });
});

describe("selected scene prompt tools", () => {
  it("rewrites from the cards when no feedback is given, limited to the ticked prompts", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const props = tools();
    fireEvent.click(screen.getByLabelText("Video"));
    fireEvent.click(screen.getByLabelText("Start frame"));
    fireEvent.click(screen.getByRole("button", { name: "Rewrite 2 scenes' prompts" }));
    expect(props.onRewrite).toHaveBeenCalledWith(["s1", "s3"], { passes: ["image"], frames: ["end"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies feedback directly to the picked scenes and reports what changed", async () => {
    const record = { project: { id: "p1" }, storyboard: { scenes } } as unknown as ProjectRecord;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      record,
      refined: [{ sceneId: "s1", sceneNumber: 1, summary: "Glasses on.", warnings: [] }],
      failed: [{ sceneId: "s3", sceneNumber: 3, error: "The model could not produce a consistent proposal." }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const props = tools();
    fireEvent.click(screen.getByLabelText("End frame"));
    fireEvent.change(screen.getByLabelText(/Refine with feedback/), { target: { value: "Mara wears glasses." } });
    fireEvent.click(screen.getByRole("button", { name: "Refine 2 scenes with feedback" }));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(record));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/projects/p1/feedback");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      sceneIds: ["s1", "s3"], targets: ["start", "video"], feedback: "Mara wears glasses.",
    });
    expect(props.onRewrite).not.toHaveBeenCalled();
    const status = screen.getByTestId("selected-scene-feedback-result");
    expect(status).toHaveTextContent("Refined scene 1");
    expect(status).toHaveTextContent("Scene 3: The model could not produce a consistent proposal.");
  });

  it("offers no video target for a keyframes-only project and needs at least one target", () => {
    tools(false);
    expect(screen.getByLabelText("Video")).toBeDisabled();
    expect(screen.getByLabelText("Video")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Start frame"));
    fireEvent.click(screen.getByLabelText("End frame"));
    expect(screen.getByRole("button", { name: "Rewrite 2 scenes' prompts" })).toBeDisabled();
  });

  it("previews card corrections first and, on accept, saves them with the ticked targets", async () => {
    const preview = {
      sourceHash: "a".repeat(64),
      scenes: [{
        sceneId: "s1", sceneNumber: 1, summary: "She picks up the cup.",
        edit: { sceneId: "s1", card: { actionDescription: "Mara picks up the cup." }, wardrobe: null },
        changes: [{ field: "actionDescription", before: "Mara picks up the phone.", after: "Mara picks up the cup.", reason: "Cup." }],
      }],
      failed: [{ sceneId: "s3", sceneNumber: 3, error: "No usable card correction." }],
      warnings: [],
    };
    const record = { project: { id: "p1" }, storyboard: { scenes } } as unknown as ProjectRecord;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === "PUT" ? { record, promptsRewritten: true } : preview), { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const props = tools();
    fireEvent.change(screen.getByLabelText(/Refine with feedback/), { target: { value: "The cup, not the phone." } });
    fireEvent.click(screen.getByLabelText("Also correct the scene cards"));
    fireEvent.click(screen.getByLabelText("Video"));
    fireEvent.click(screen.getByRole("button", { name: "Preview card changes for 2 scenes" }));

    const box = await screen.findByTestId("card-feedback-preview");
    expect(box).toHaveTextContent("Action");
    expect(box).toHaveTextContent("Mara picks up the cup.");
    expect(box).toHaveTextContent("Scene 3: No usable card correction.");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/projects/p1/feedback/cards");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ sceneIds: ["s1", "s3"], feedback: "The cup, not the phone." });
    expect(props.onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Accept and rewrite prompts" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(record));
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      sourceHash: preview.sourceHash, targets: ["start", "end"], edits: [preview.scenes[0]!.edit],
    });
    expect(screen.getByRole("status")).toHaveTextContent("Cards saved and prompts rewritten for scene 1");
    expect(screen.queryByTestId("card-feedback-preview")).toBeNull();
  });
});
