import { describe, expect, it } from "vitest";

import { depictsSexAct } from "@/lib/agents/prompt-gate";
import type { SceneDraft } from "@/lib/schemas/storyboard";

function draft(fields: Partial<SceneDraft>): SceneDraft {
  return {
    id: "p-scene-003",
    projectId: "p",
    sceneNumber: 3,
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    title: "The Verdict",
    sceneObjective: "",
    storyBeat: "",
    visualDescription: "",
    actionDescription: "",
    cameraMovement: "",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: "",
    subjectFaceVisible: true,
    charactersPresent: [],
    ...fields,
  } as SceneDraft;
}

describe("an act somebody talks about is not an act the frame shows", () => {
  it("does not read a reported answer as a depicted act", () => {
    // The scene that prompted this: a clothed two-shot of two faces, where the
    // only explicit words on the card are what a character says out loud.
    const scene = draft({
      storyBeat: "The man answers that he finds her attractive and wouldn't mind having her suck his cock.",
      visualDescription: "Close-up two-shot, both faces lit warm, dark panelling behind them.",
      actionDescription: "He sets the tray down and turns toward them, hands open and still.",
    });
    expect(depictsSexAct(scene)).toBe(false);
  });

  it.each([
    ["says", "She says she wants him inside her."],
    ["asks", "He asks whether she would ride him."],
    ["admits", "She admits she has thought about his cock all evening."],
    ["imagines", "He imagines her straddling him on the chaise."],
    ["offers", "She offers to go down on him later."],
  ])("treats a %s clause as talk, not action", (_verb, storyBeat) => {
    expect(depictsSexAct(draft({ storyBeat }))).toBe(false);
  });

  it("still sees an act that follows the speech in the same sentence", () => {
    // The clause ends at the conjunction that returns to what is shown, so
    // stripping the talk must not take the action with it.
    const scene = draft({
      actionDescription: "She says his name as he thrusts into her.",
    });
    expect(depictsSexAct(scene)).toBe(true);
  });

  it.each([
    ["while", "He tells her to stay quiet while she straddles him."],
    ["when", "She whispers a warning when he enters her."],
  ])("keeps the act after a %s clause", (_word, actionDescription) => {
    expect(depictsSexAct(draft({ actionDescription }))).toBe(true);
  });

  it("still sees a plainly depicted act", () => {
    const scene = draft({
      actionDescription: "She straddles him on the chaise, taking him inside her.",
    });
    expect(depictsSexAct(scene)).toBe(true);
  });

  it("still sees an act described elsewhere on a card that also has dialogue", () => {
    const scene = draft({
      storyBeat: "He says he has waited all night for this.",
      actionDescription: "He penetrates her from behind, her hands braced on the headboard.",
    });
    expect(depictsSexAct(scene)).toBe(true);
  });
});
