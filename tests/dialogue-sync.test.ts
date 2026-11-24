import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changesDialogue, isSkip, proposeSceneDialogue, type DialogueSyncProposal } from "@/lib/agents/dialogue-sync";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Copying a video prompt's dialogue back onto its scene card.
 *
 * The card's dialogue decides what generation treats as speech, who says it
 * and whose voice it is in, so a line reworded only in the prompt was a line
 * generation no longer recognised.
 */

function scene(prompt: string, dialogue: { character: string; line: string }[], extra: Partial<Scene> = {}): Scene {
  return {
    id: "s1",
    sceneNumber: 1,
    title: "The Kitchen",
    dialogue,
    prompts: { videoPromptSegment: prompt },
    ...extra,
  } as unknown as Scene;
}

function propose(s: Scene, cast: string[] = ["TLBr3f"]): DialogueSyncProposal {
  const result = proposeSceneDialogue(s, cast);
  if (isSkip(result)) throw new Error(result.reason);
  return result;
}

describe("proposing a card's dialogue from its video prompt", () => {
  /** From a live project whose card still held the lines the prompt had replaced. */
  it("takes both rewritten lines, each with the speaker who says it", () => {
    const proposal = propose(scene(
      "TLBr3f gasps awake beneath him. The Black Man rolls a dirty voice low across the floor: " +
        '"Tracey - I got you now - you thought you could run away." Her breath catches and she says: ' +
        '"who are you—please, don\'t do this!" Slow push-in.',
      [
        { character: "The Black Man", line: '"Tracey."' },
        { character: "TLBr3f", line: '"Hh—gah!"' },
      ],
    ));

    expect(proposal.after.map(({ character, line, status, speakerFrom }) => ({ character, line, status, speakerFrom })))
      .toEqual([
        { character: "The Black Man", line: "Tracey - I got you now - you thought you could run away.", status: "reworded", speakerFrom: "named" },
        { character: "TLBr3f", line: "who are you—please, don't do this!", status: "reworded", speakerFrom: "guessed" },
      ]);
    expect(proposal.after[1]!.replaces).toBe("Hh—gah!");
    expect(proposal.removed).toEqual([]);
    expect(changesDialogue(proposal)).toBe(true);
  });

  it("changes nothing when the card already says what the prompt says", () => {
    const proposal = propose(scene(
      'TLBr3f speaks: "Come on, come on." Juan says, "Mm. Good."',
      [{ character: "TLBr3f", line: "Come on, come on." }, { character: "Juan", line: "Mm. Good." }],
    ));
    expect(changesDialogue(proposal)).toBe(false);
  });

  it("keeps a reworded line with its card speaker, whoever it names", () => {
    const proposal = propose(scene(
      'He growls, "Faster, take it faster, Tracey, my girl."',
      [{ character: "Leroy", line: "Faster, take it faster, baby." }],
      { charactersPresent: ["TLBr3f", "Leroy"] },
    ));
    expect(proposal.after).toMatchObject([
      { character: "Leroy", line: "Faster, take it faster, Tracey, my girl.", status: "reworded", speakerFrom: "card" },
    ]);
  });

  it("keeps one card line the prompt split around its delivery as one line", () => {
    const proposal = propose(scene(
      '"Still got it." she says. "Bare feet on wet sand beats sandals any day."',
      [{ character: "TLBr3f", line: "Still got it. Bare feet on wet sand beats sandals any day." }],
    ));
    expect(proposal.after).toHaveLength(1);
    expect(proposal.after[0]).toMatchObject({ status: "unchanged", character: "TLBr3f" });
  });

  it("keeps stage directions and ignores quotations that are not speech", () => {
    const proposal = propose(scene(
      'A sign reads "CLOSED". Colin says, "Can I come in?"',
      [{ character: "Colin", line: "Can I?" }, { character: "TLBr3f", line: "(Nods)" }],
      { charactersPresent: ["TLBr3f", "Colin"] },
    ));
    expect(proposal.after.map((l) => l.line)).toEqual(["Can I come in?", "(Nods)"]);
    expect(proposal.kept).toEqual([{ character: "TLBr3f", line: "(Nods)" }]);
  });

  it("flags a prompt that quotes no speech, which would empty the card", () => {
    const proposal = propose(scene("She walks to the door.", [{ character: "TLBr3f", line: "Come on." }]));
    expect(proposal.emptiesDialogue).toBe(true);
    expect(proposal.removed).toEqual([{ character: "TLBr3f", line: "Come on." }]);
  });

  it("leaves the speaker to be chosen when nothing in the prompt says who it is", () => {
    const proposal = propose(scene(
      'Somebody shouts "Get out!" and somebody else cries "Now!"',
      [{ character: "TLBr3f", line: "Hello." }],
      { charactersPresent: [] },
    ), []);
    expect(proposal.after.every((l) => l.speakerFrom === "unknown" && l.character === "")).toBe(true);
  });

  it("refuses a scene with no video prompt", () => {
    expect(isSkip(proposeSceneDialogue(scene("", []), []))).toBe(true);
  });
});

describe("previewing and applying a dialogue copy", () => {
  const dirs: string[] = [];

  async function isolated() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-dialogue-sync-"));
    dirs.push(dir);
    process.env.STORYFORGE_DATA_DIR = dir;
    vi.resetModules();
    const projects = await import("@/lib/services/project-service");
    const sync = await import("@/lib/services/dialogue-sync-service");
    const project = await projects.createProject({
      concept: "Mara asks Jon to leave before the rain starts.",
      requestedDurationSeconds: 40,
      dialogueRequired: true,
    });
    await projects.generateStoryboard(project.id);
    const record = await projects.getProjectRecord(project.id);
    const first = record.storyboard!.scenes[0]!;
    const speaker = first.dialogue![0]!.character;
    await projects.updateScenePrompts(project.id, first.id, {
      videoPromptSegment: `${speaker} turns to the window and says, "We leave tonight, before the storm."`,
    });
    return { projects, sync, projectId: project.id, sceneId: first.id, speaker };
  }

  afterEach(async () => {
    delete process.env.STORYFORGE_DATA_DIR;
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("saves the previewed dialogue to the card and leaves the prompt alone", async () => {
    const { projects, sync, projectId, sceneId, speaker } = await isolated();
    const preview = await sync.previewDialogueSync(projectId, { sceneIds: [sceneId] });
    expect(preview.scenes).toHaveLength(1);
    const proposed = preview.scenes[0]!;
    expect(proposed.after.map((l) => l.line)).toEqual(["We leave tonight, before the storm."]);

    const promptBefore = (await projects.getProjectRecord(projectId)).storyboard!.scenes[0]!.prompts.videoPromptSegment;
    const { record, updated } = await sync.applyDialogueSync(projectId, {
      scenes: [{
        sceneId,
        sceneHash: proposed.sceneHash,
        dialogue: proposed.after.map(({ character, line }) => ({ character, line })),
      }],
    });

    const saved = record.storyboard!.scenes.find((s) => s.id === sceneId)!;
    expect(updated).toEqual([1]);
    expect(saved.dialogue).toEqual([{ character: speaker, line: "We leave tonight, before the storm." }]);
    expect(saved.prompts.videoPromptSegment).toBe(promptBefore);
    // The card now has what the prompt says, so there is nothing left to copy.
    expect((await sync.previewDialogueSync(projectId, { sceneIds: [sceneId] })).scenes).toEqual([]);
  });

  it("refuses to save when the prompt changed after the preview, and saves nothing", async () => {
    const { projects, sync, projectId, sceneId, speaker } = await isolated();
    const preview = await sync.previewDialogueSync(projectId, { sceneIds: [sceneId] });
    const before = (await projects.getProjectRecord(projectId)).storyboard!.scenes[0]!.dialogue;
    await projects.updateScenePrompts(projectId, sceneId, {
      videoPromptSegment: `${speaker} says, "Something else entirely."`,
    });

    await expect(sync.applyDialogueSync(projectId, {
      scenes: [{ sceneId, sceneHash: preview.scenes[0]!.sceneHash, dialogue: [{ character: speaker, line: "x" }] }],
    })).rejects.toThrow(/changed after this preview/);
    expect((await projects.getProjectRecord(projectId)).storyboard!.scenes[0]!.dialogue).toEqual(before);
  });

  it("refuses a line with no speaker", async () => {
    const { sync, projectId, sceneId } = await isolated();
    const preview = await sync.previewDialogueSync(projectId, { sceneIds: [sceneId] });
    await expect(sync.applyDialogueSync(projectId, {
      scenes: [{ sceneId, sceneHash: preview.scenes[0]!.sceneHash, dialogue: [{ character: " ", line: "Hi." }] }],
    })).rejects.toThrow(/speaker/);
  });
});
