import { beforeEach, describe, expect, it } from "vitest";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { charactersInFrame, frameCast } from "@/lib/agents/scene-cast";
import { sceneFrameParticipants } from "@/lib/agents/frame-contract";
import { rebuiltPrompts } from "@/lib/agents/cast-sheet";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import { imagePromptWarnings, storedSceneImageContext } from "@/lib/agents/prompt-validation";
import { positiveConstraintClause } from "@/lib/agents/negative-prompt";
import { createProject, generateStoryboard, updateSceneCard, updateScenePrompts } from "@/lib/services/project-service";
import { generateSceneMedia } from "@/lib/services/media-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { buildVideoManifest } from "@/lib/services/wangp-service";
import { simplifyPrompt } from "@/lib/agents/prompt-simplifier";
import { wardrobeConflicts } from "@/lib/agents/prompt-gate";
import type { Character } from "@/lib/schemas/character";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Scene } from "@/lib/schemas/storyboard";

const ana: Character = {
  id: "ana", name: "Ana", description: "A woman with brown curly hair.",
  wardrobe: "a blue cotton dress", createdAt: "now", updatedAt: "now",
};
const start = "Medium shot, eye level. Ana in a blue cotton dress stands beside James at the table. James holds one playing card. Exactly two people are in frame.";
const end = "Close-up, eye level. James holds one playing card over the wooden table. Exactly one man is in frame.";

beforeEach(() => setWangpClient(new MockWangpClient()));

async function fixture() {
  const project = await createProject({
    concept: "Ana watches James finish a card game.", requestedDurationSeconds: 100,
    sceneContinuity: "cut", generationMode: "keyframes_only",
  });
  const record = await generateStoryboard(project.id);
  const scene: Scene = {
    ...record.storyboard!.scenes[0]!,
    visualDescription: "James, a white-haired man, holds one playing card. Ana stands beside him. She is a woman with brown hair.",
    actionDescription: "James holds one playing card over the table.",
    frameVisibility: { start: ["Ana", "James"], end: ["James"] },
    prompts: { ...record.storyboard!.scenes[0]!.prompts, startFramePrompt: start, endFramePrompt: end },
  };
  return { project, record, scene };
}

describe("authoritative frame state", () => {
  it("does not reintroduce a library character into a non-library person's solo frame", async () => {
    const { project, scene } = await fixture();
    expect(charactersInFrame(end, [ana])).toEqual([]);
    expect(frameCast(scene, "end", end, [ana])).toEqual([]);
    const wardrobe = wardrobeTimeline(project, [scene], [ana]).get(scene.id);
    expect(rebuiltPrompts(scene, [ana], wardrobe).endFramePrompt).not.toContain("Ana");
  });

  it("keeps explicitly empty frame visibility empty even if a stale prompt names someone", async () => {
    const { scene } = await fixture();
    expect(frameCast({ ...scene, frameVisibility: { start: [], end: [] } }, "end", start, [ana])).toEqual([]);
  });

  it("does not double-count a named person described again through a pronoun", async () => {
    const { scene } = await fixture();
    expect(sceneFrameParticipants({ ...scene, frameVisibility: undefined }, [ana], [
      { name: "James", description: "A man with white hair." },
    ]).end.people).toBe(2);
  });

  it("gives the writer current wardrobe but not the full project or future wardrobe narrative", async () => {
    const { project, scene } = await fixture();
    project.characterWardrobe = { ana: "a blue cotton dress" };
    project.wardrobeChanges = { later: [{ characterId: "ana", wardrobe: "a red coat", mode: "between" }] };
    const calls: { system: string; user: string }[] = [];
    const provider: PlanningProvider = {
      name: "state-test",
      generateJson: async (system, user, schema) => {
        calls.push({ system, user });
        return schema.parse({ startFramePrompt: start, endFramePrompt: end, imageNegativePrompt: "watermark" });
      },
    };
    const { prompts: _prompts, ...draft } = scene;
    const [result] = await attachScenePrompts(project, [draft], provider, {
      cast: [ana], visualBible: { ...((await generateStoryboard(project.id)).storyboard!.visualBible),
        characters: [{ name: "Ana", description: ana.description }, { name: "James", description: "A white-haired man." }] },
      plans: { artDirectionPlan: {
        projectId: project.id, productionDesign: "FUTURE_EVENT_SENTINEL", colorScript: "",
        wardrobeRules: ["FUTURE_EVENT_SENTINEL: change into a red coat in scene 5."], propRules: [], setDressingRules: [],
      } },
    });
    expect(calls[0]!.user).not.toContain("FUTURE_EVENT_SENTINEL");
    const payload = JSON.parse(calls[0]!.user);
    expect(payload.project.wardrobeChanges).toBeUndefined();
    expect(payload.wardrobe.start.Ana).toBe("a blue cotton dress");
    expect(result!.prompts.endFramePrompt).not.toContain("Character continuity");
    expect(result!.prompts.endFramePrompt).not.toContain("Ana");
  });

  it("warns about premature undressing against the current timeline, not a future change", async () => {
    const { project, scene } = await fixture();
    project.characterWardrobe = { ana: "a blue cotton dress" };
    const current = { ...scene, frameVisibility: { start: ["Ana"], end: ["Ana"] } };
    const context = storedSceneImageContext(project, current, [ana], undefined, [current]);
    const warnings = imagePromptWarnings(
      "Medium shot, eye level. Ana stands fully naked at the table with the card. Exactly one woman is in frame.",
      "end", context,
    );
    expect(warnings).toContain("end: wardrobe_state_conflict");
    expect(warnings.some((warning) => warning.includes("blue cotton dress"))).toBe(true);
    expect(context.wardrobeByPerson?.end.Ana).toBe("a blue cotton dress");
  });

  it("saves final warnings and allows image generation, as requested", async () => {
    const { project, scene } = await fixture();
    await updateSceneCard(project.id, scene.id, { frameVisibility: { start: ["James"], end: [] } });
    await updateScenePrompts(project.id, scene.id, { startFramePrompt: end, endFramePrompt: start });
    const generated = await generateSceneMedia(project.id, scene.id);
    const attempt = generated.attempts![scene.id]!.at(-1)!;
    expect(attempt.endImagePath).toBeTruthy();
    expect(attempt.promptWarnings).toContain("end: participant_unexpected");
  });

  it("does not turn a missing headcount into a new single-person constraint", () => {
    expect(positiveConstraintClause("extra limbs", null)).not.toContain("single");
  });

  it("binds clothing claims to their owner rather than another person in the same sentence", () => {
    expect(wardrobeConflicts("Ana is wearing a blue cotton dress beside Ben, who is fully naked.",
      { Ana: "a blue cotton dress", Ben: "nude" }, ["Ana", "Ben"],
    )).toEqual([]);
    expect(wardrobeConflicts("Ana is wearing a red cotton dress at the table.",
      { Ana: "a blue cotton dress" },
    )).toHaveLength(1);
  });

  it("retries wrong action/speaker attribution and keeps unresolved video problems advisory", async () => {
    const { project, scene } = await fixture();
    const current = {
      ...scene, dialogue: [{ character: "James", line: "The game is over." }],
      frameVisibility: { start: ["James"], end: ["James"] },
    };
    const calls: string[] = [];
    const provider: PlanningProvider = {
      name: "video-contract-test",
      generateJson: async (system, _user, schema) => {
        calls.push(system);
        return schema.parse({
          videoPromptSegment: 'A cyclist races through an outdoor market. Narrator says, "The game is over."',
          videoNegativePrompt: "flicker", promptQualityChecklist: [],
        });
      },
    };
    const { prompts, ...draft } = current;
    const [rewritten] = await attachScenePrompts(project, [draft], provider, {
      existing: { [draft.id]: prompts }, passes: ["video"],
    });
    expect(calls).toHaveLength(2);
    expect(rewritten!.prompts.videoPromptSegment).toContain("cyclist");
    expect(rewritten!.prompts.promptWarnings?.some((warning) => warning.startsWith("video:"))).toBe(true);
    const manifest = await buildVideoManifest({
      sceneId: draft.id, prompt: rewritten!.prompts.videoPromptSegment,
      imageStart: "C:\\frames\\start.png", imageEnd: "C:\\frames\\end.png",
      modelStrategy: "auto", modelType: "wan_i2v_14b",
      validation: { scene: draft, participants: ["James"] },
    });
    expect(manifest.promptWarnings?.length).toBeGreaterThan(0);
    expect(manifest.settings.prompt).toContain("cyclist");
  });

  it("refuses a simplification that deletes the frame's only visible person", async () => {
    const { project, scene } = await fixture();
    const provider: PlanningProvider = {
      name: "bad-simplification",
      generateJson: async (_system, _user, schema) => schema.parse({ prompt: "An empty room." }),
    };
    await expect(simplifyPrompt(scene, "endFramePrompt", provider,
      storedSceneImageContext(project, scene, [ana]),
    )).rejects.toThrow(/preserving the frame/);
  });
});
