import { describe, it, expect } from "vitest";
import { carryEndFramesForward } from "@/lib/agents/continuity";
import { createProject, generateStoryboard, getProjectRecord, updateScenePrompts } from "@/lib/services/project-service";
import { repository } from "@/lib/db/store";
import type { Project } from "@/lib/schemas/project";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * An edited closing frame carries into the opening that inherits it.
 *
 * Under "continue from the last frame" the next scene opens on this scene's end
 * frame, so its start prompt must describe the same picture. Editing an end
 * prompt by hand left the next opening describing the old ending, and the only
 * fix was to copy and paste it across scene by scene.
 */

const OLD_END = "Medium shot, eye level. Mara sets the cup down.";
const NEW_END = "Medium shot, eye level. Mara sets the cup down and folds her hands.";

function scene(n: number, start: string, end: string, over: Partial<Scene> = {}): Scene {
  return {
    id: `s${n}`, projectId: "p", sceneNumber: n, startTimeSeconds: 0, endTimeSeconds: 20,
    targetDurationSeconds: 20, title: "t", sceneObjective: "o", storyBeat: "b",
    visualDescription: "Medium shot of Mara.", actionDescription: "a", cameraMovement: "static",
    transitionIn: "Continuous", transitionOut: "Continuous", continuityNotes: [],
    subjectFaceVisible: true, dialogue: [], status: "generated",
    prompts: {
      startFramePrompt: start, endFramePrompt: end, imageNegativePrompt: "",
      videoPromptSegment: "", videoNegativePrompt: "", promptQualityChecklist: [],
    },
    ...over,
  } as Scene;
}

const continuing = { sceneContinuity: "reuse_end_frame", generationMode: "keyframes_only" } as Project;

function edited(before: Scene[], index: number, end: string): Scene[] {
  return before.map((s, i) => (i === index ? { ...s, prompts: { ...s.prompts, endFramePrompt: end } } : s));
}

describe("carrying an edited ending into the next opening", () => {
  it("copies the new ending into an opening that was a copy of the old one", () => {
    const before = [scene(1, "open", OLD_END), scene(2, OLD_END, "close")];
    const { scenes, carried } = carryEndFramesForward(continuing, before, edited(before, 0, NEW_END));
    expect(scenes[1]!.prompts.startFramePrompt).toBe(NEW_END);
    expect(carried).toEqual(["s2"]);
  });

  it("refreshes a stale opening the seam still continues from", () => {
    const before = [scene(1, "open", OLD_END), scene(2, "Medium shot, eye level. An older wording.", "close")];
    const { scenes } = carryEndFramesForward(continuing, before, edited(before, 0, NEW_END));
    expect(scenes[1]!.prompts.startFramePrompt).toBe(NEW_END);
  });

  it("leaves the opening of a planned cut alone", () => {
    const before = [scene(1, "open", OLD_END), scene(2, "Close-up, low angle. Her hands.", "close", { transitionIn: "Hard cut" })];
    const { scenes, carried } = carryEndFramesForward(continuing, before, edited(before, 0, NEW_END));
    expect(scenes[1]!.prompts.startFramePrompt).toBe("Close-up, low angle. Her hands.");
    expect(carried).toEqual([]);
  });

  it("does nothing when scenes do not continue from the last frame", () => {
    const before = [scene(1, "open", OLD_END), scene(2, OLD_END, "close")];
    const cut = { ...continuing, sceneContinuity: "cut" } as Project;
    expect(carryEndFramesForward(cut, before, edited(before, 0, NEW_END)).carried).toEqual([]);
  });

  it("keeps an opening the same change set explicitly", () => {
    const before = [scene(1, "open", OLD_END), scene(2, OLD_END, "close")];
    const after = edited(before, 0, NEW_END);
    after[1] = { ...after[1]!, prompts: { ...after[1]!.prompts, startFramePrompt: "Chosen by hand." } };
    expect(carryEndFramesForward(continuing, before, after).scenes[1]!.prompts.startFramePrompt).toBe("Chosen by hand.");
  });

  it("only carries one step: the next scene's own ending is untouched", () => {
    const before = [scene(1, "open", OLD_END), scene(2, OLD_END, "close"), scene(3, "close", "end")];
    const { scenes } = carryEndFramesForward(continuing, before, edited(before, 0, NEW_END));
    expect(scenes[1]!.prompts.endFramePrompt).toBe("close");
    expect(scenes[2]!.prompts.startFramePrompt).toBe("close");
  });
});

describe("editing an end prompt in the scene panel", () => {
  it("updates the next scene's opening in the same save", async () => {
    const created = await createProject({
      concept: "A keeper argues with his daughter.",
      requestedDurationSeconds: 40,
      sceneContinuity: "reuse_end_frame",
    });
    const record = await generateStoryboard(created.id);
    const [first, second] = record.storyboard!.scenes;
    // Make the second scene open on the first one's ending, as a continuous take writes it.
    await repository.update(created.id, {
      ...record,
      storyboard: {
        ...record.storyboard!,
        scenes: record.storyboard!.scenes.map((s) => s.id === second!.id
          ? { ...s, transitionIn: "Continuous", prompts: { ...s.prompts, startFramePrompt: first!.prompts.endFramePrompt } }
          : s),
      },
    });

    const edit = `${first!.prompts.endFramePrompt} She folds her hands.`;
    await updateScenePrompts(created.id, first!.id, { endFramePrompt: edit });

    const after = await getProjectRecord(created.id);
    expect(after.storyboard!.scenes[1]!.prompts.startFramePrompt).toBe(edit);
    expect(after.history?.at(-1)?.detail).toBe("Scene 1; opening of scene 2 follows it");
  });
});
