import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneCardEditor } from "@/components/storyboard/scene-card-editor";
import { sceneSchema } from "@/lib/schemas/storyboard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("saves endpoint visibility separately, including an empty opening frame", async () => {
  const scene = sceneSchema.parse({
    id: "s1", projectId: "p1", sceneNumber: 1, startTimeSeconds: 0, endTimeSeconds: 20,
    targetDurationSeconds: 20, title: "Cards", sceneObjective: "Finish a game",
    storyBeat: "James folds", visualDescription: "Ana watches James.",
    actionDescription: "James folds one card.", cameraMovement: "Static",
    transitionIn: "Cut", transitionOut: "Cut", status: "planned",
    frameVisibility: { start: ["Ana", "James"], end: ["James"] },
    prompts: { startFramePrompt: "", endFramePrompt: "", imageNegativePrompt: "",
      videoPromptSegment: "", videoNegativePrompt: "" },
  });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project: { id: "p1" } })));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<SceneCardEditor scene={scene} projectId="p1" />);
  await user.click(screen.getByText("Scene card"));
  const opening = screen.getByRole("textbox", { name: /People visible in the opening frame/ });
  expect(opening).toHaveValue("Ana, James");
  await user.clear(opening);
  await user.click(screen.getByRole("button", { name: /^Save card only$/ }));
  expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/scenes/s1/card", expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ frameVisibility: { start: [], end: ["James"] } }),
  }));
});
