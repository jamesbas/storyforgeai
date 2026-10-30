import { describe, expect, it } from "vitest";
import { sceneFrameParticipants, physicalContradictions } from "@/lib/agents/frame-contract";
import { gateImagePrompt, gateFramePair } from "@/lib/agents/prompt-gate";
import { imageConstraintSentences } from "@/lib/agents/prompt-concision";
import { trimToBudget } from "@/lib/agents/media-prompt-renderers";
import { sceneDraftSchema } from "@/lib/schemas/storyboard";
import { statedHeadcount } from "@/lib/media/seam";
import type { Character } from "@/lib/schemas/character";

const ana: Character = {
  id: "ana", name: "Ana", description: "A woman with short curly hair.",
  createdAt: "now", updatedAt: "now",
};
const ben = { ...ana, id: "ben", name: "Ben", description: "A bearded man." };
const scene = (visualDescription: string, actionDescription = visualDescription) => sceneDraftSchema.parse({
  id: "scene-1", projectId: "p1", sceneNumber: 1,
  startTimeSeconds: 0, endTimeSeconds: 8, targetDurationSeconds: 8,
  title: "Workshop", sceneObjective: "Demonstrate safety", storyBeat: "A careful demonstration",
  visualDescription, actionDescription, cameraMovement: "Static",
  transitionIn: "Cut", transitionOut: "Cut", status: "planned",
});

describe("frame participant contracts", () => {
  it("counts a pinned woman and two supporting men only once across both card fields", () => {
    const card = scene("Ana stands beside two tall men at a workshop table.");
    expect(sceneFrameParticipants(card, [ana])).toEqual({
      start: { names: ["Ana"], people: 3 }, end: { names: ["Ana"], people: 3 },
    });
  });

  it("recovers supporting names from an existing bible without pinning them", () => {
    const card = scene("Ana and Ben hold a yellow toolbox.");
    expect(sceneFrameParticipants(card, [ana], [ben]).end).toEqual({ names: ["Ana", "Ben"], people: 2 });
  });

  it("does not add people who only appear in the bible or in dialogue", () => {
    const card = { ...scene("Ana holds a toolbox."), dialogue: [{ character: "Ana", line: "Ben called." }] };
    expect(sceneFrameParticipants(card, [ana], [ben]).end).toEqual({ names: ["Ana"], people: 1 });
  });

  it("does not count the same person twice through a generic numbered description", () => {
    const card = scene("One woman, Ana, and two men stand beside the table.");
    expect(sceneFrameParticipants(card, [ana]).end.people).toBe(3);
    expect(sceneFrameParticipants(
      scene("Exactly three people are in frame: Ana, Ben and Cara."), [ana, ben],
      [{ name: "Cara", description: "A woman." }],
    ).end.people).toBe(3);
  });

  it("counts unpinned singular people and a second man without duplicating their later mentions", () => {
    const card = scene("A woman stands beside two men at a table.");
    expect(sceneFrameParticipants(card, []).end.people).toBe(3);
    expect(sceneFrameParticipants(scene(
      "A man stands on the left. A second man stands on the right.",
      "The second man holds a toolbox.",
    ), []).end.people).toBe(2);
  });

  it("does not mistake a named man beside two other men for a member of their group", () => {
    expect(sceneFrameParticipants(scene("Ben stands beside two men at a table."), [ben])
      .end.people).toBe(3);
    expect(sceneFrameParticipants(scene("Ana stands with two friends at a table."), [ana])
      .end.people).toBe(3);
  });

  it("recognizes an explicitly named member of a group without adding a copy", () => {
    expect(sceneFrameParticipants(scene("Two men, Ben and Dan, stand at the table."), [ben])
      .end.people).toBe(2);
    expect(sceneFrameParticipants(scene("Ben stands at the table. A second man stands beside Ben."), [ben])
      .end.people).toBe(2);
  });

  it("does not count a bible label for a numbered group as another individual", () => {
    const card = scene("Ana and two crew members stand beside the table.");
    expect(sceneFrameParticipants(card, [ana], [
      { name: "Crew members", description: "Two assistants in blue overalls." },
    ]).end.people).toBe(3);
  });

  it("keeps a scripted departure out of the closing requirements", () => {
    const card = scene("Ana and Ben stand at the table.", "Ben exits. Ana holds the toolbox.");
    const expected = sceneFrameParticipants(card, [ana, ben]);
    expect(expected.start).toEqual({ names: ["Ana", "Ben"], people: 2 });
    expect(expected.end).toEqual({ names: ["Ana"], people: 1 });
    expect(gateFramePair("Exactly two people are in frame.", "Exactly one person is in frame.", {
      clipCarriesArrivals: false, expected,
    })).toEqual([]);
  });

  it("keeps a scripted arrival out of the opening requirements", () => {
    const card = scene("Ana and Ben stand at the table.", "Ben enters. Ana holds the toolbox.");
    const expected = sceneFrameParticipants(card, [ana, ben]);
    expect(expected.start).toEqual({ names: ["Ana"], people: 1 });
    expect(expected.end.people).toBe(2);
  });

  it("does not force an explicitly offscreen person into a close-up", () => {
    const card = scene("Close-up of Ana at the table. Ben remains offscreen.");
    expect(sceneFrameParticipants(card, [ana, ben]).end).toEqual({ names: ["Ana"], people: 1 });
  });

  it("reads an inherited opening rather than forcing the next scene's cast into it", () => {
    const card = scene("Ana and Ben stand at the table.");
    expect(sceneFrameParticipants(card, [ana, ben], [], [], "Ana holds a toolbox. Exactly one person is in frame.")
      .start).toEqual({ names: ["Ana"], people: 1 });
  });

  it("rejects a collapsed group, including when the writer omits its headcount", () => {
    const card = scene("Ana holds a silver clipboard at the table. Two crew members stand beside Ana.");
    const context = {
      scene: card, participants: ["Ana"], explicit: false,
      frameParticipants: sceneFrameParticipants(card, [ana]),
    };
    const prompt = "Wide shot, eye level. Ana holds a silver clipboard at the table.";
    expect(gateImagePrompt(`${prompt} Exactly one person is in frame.`, "end", context))
      .toContain("headcount_mismatch");
    expect(gateImagePrompt(prompt, "end", context)).toContain("headcount_missing");
  });

  it("checks supporting people by whole name, not a substring", () => {
    const card = scene("Ana and Ben stand together.");
    const context = {
      scene: card, participants: ["Ana"], explicit: false,
      frameParticipants: sceneFrameParticipants(card, [ana], [ben]),
    };
    expect(gateImagePrompt(
      "Wide shot, eye level. Ana and Benedict stand together. Exactly two people are in frame.", "end", context,
    )).toContain("participant_missing");
  });

  it("accepts word-form counts above five", () => {
    expect(statedHeadcount("Exactly seven people are in frame.")).toBe(7);
    expect(statedHeadcount("Exactly twelve people are in frame.")).toBe(12);
  });
});

describe("preserving physical constraints", () => {
  it("keeps late contact and ownership sentences before optional lighting", () => {
    const text = "Wide shot, eye level. Ana stands on the left. Ben stands on the right. " +
      "Soft amber lighting illuminates the plain white workshop walls and the polished wooden table. " +
      "Her left hand is free while his right hand holds her right wrist.";
    const fitted = trimToBudget(text, 31, 1, imageConstraintSentences(text));
    expect(fitted).toContain("holds her right wrist");
    expect(fitted).not.toContain("amber lighting");
  });

  it("flags incompatible poses for the same person but not two different people", () => {
    expect(physicalContradictions("Ana stands beside the table. Ana sits on the floor.", ["Ana"]))
      .toContain("pose_conflict");
    expect(physicalContradictions("Ana stands beside the table. Ben sits on the floor.", ["Ana", "Ben"]))
      .toEqual([]);
  });

  it("flags an owned hand simultaneously empty and occupied, including 'the same' references", () => {
    expect(physicalContradictions(
      "Ana's right hand holds Ben's wrist. The same right hand is empty.", ["Ana", "Ben"],
    )).toContain("limb_conflict");
    expect(physicalContradictions(
      "Ana's right hand is bound. The same right hand is free.", ["Ana"],
    )).toContain("limb_conflict");
    expect(physicalContradictions(
      "Ana's right hand holds Ben's wrist. Ana's left hand is free.", ["Ana", "Ben"],
    )).toEqual([]);
  });

  it("does not confuse two owners or a different side with a same-hand reference", () => {
    expect(physicalContradictions("Ana's right hand holds a rope. Ben's right hand is free.", ["Ana", "Ben"]))
      .toEqual([]);
    expect(physicalContradictions("Ana's right hand holds a rope. The same left hand is free.", ["Ana"]))
      .toEqual([]);
    expect(physicalContradictions(
      "John Smith's right hand holds a rope. Alex Smith's right hand is empty.", ["John Smith", "Alex Smith"],
    )).toEqual([]);
    expect(physicalContradictions(
      "The first man's right hand holds a rope. The second man's right hand is empty.", ["Ana"],
    )).toEqual([]);
  });

  it("does not treat an unrestrained hand holding a prop as a contradiction", () => {
    expect(physicalContradictions(
      "Ana's right hand holds a toolbox. Ana's right hand is free.", ["Ana"],
    )).toEqual([]);
  });
});
