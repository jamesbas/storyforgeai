import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";

/**
 * The composer changes every prompt sent to WanGP, so it sits behind
 * MEDIA_PROMPT_COMPOSER_V2. Config reads the environment once at module load,
 * so each path needs a fresh module graph.
 */
async function withComposer(enabled: boolean) {
  vi.resetModules();
  process.env.MEDIA_PROMPT_COMPOSER_V2 = enabled ? "true" : "false";
  const agents = await import("@/lib/agents/mock-agents");
  return agents;
}

const original = process.env.MEDIA_PROMPT_COMPOSER_V2;
afterEach(() => {
  if (original === undefined) delete process.env.MEDIA_PROMPT_COMPOSER_V2;
  else process.env.MEDIA_PROMPT_COMPOSER_V2 = original;
  vi.resetModules();
});

const project = {
  id: "p1",
  segmentCount: 3,
  segmentSeconds: 20,
  style: "cinematic",
  tone: "moody",
} as Project;

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "p1-scene-001",
    projectId: "p1",
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    title: "The gear",
    sceneObjective: "Seat the gear",
    storyBeat: "The apprentice commits to the repair",
    visualDescription: "Close-up of the apprentice at the bench",
    actionDescription: "She seats the gear with a firm turn. The scarf whips left.",
    cameraMovement: "Slow push-in on the subject.",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    status: "draft",
    ...overrides,
  } as SceneDraft;
}

const cast: Character[] = [
  {
    id: "c1",
    name: "Ana",
    description: "A wiry woman in her thirties with cropped dark hair",
    negativePrompt: "beard",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Character,
];

describe("the composer flag", () => {
  it("leaves v1 output in place when off", async () => {
    const { buildImagePrompts } = await withComposer(false);
    const prompts = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    expect(prompts.startFramePrompt.startsWith("Cinematic still.")).toBe(true);
  });

  it("opens with framing when on", async () => {
    const { buildImagePrompts } = await withComposer(true);
    const prompts = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    expect(prompts.startFramePrompt.startsWith("Close-up, eye level.")).toBe(true);
    expect(prompts.startFramePrompt).not.toContain("Cinematic still");
  });

  it("is reversible: turning it off restores the old text exactly", async () => {
    const on = await withComposer(true);
    const v2 = on.buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    const off = await withComposer(false);
    const v1 = off.buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    expect(v1.startFramePrompt).not.toBe(v2.startFramePrompt);
    expect(v1.startFramePrompt.startsWith("Cinematic still.")).toBe(true);
  });
});

/** FR-8/FR-9: existing enforcement must survive the new composition path. */
describe("enforcement survives the v2 path", () => {
  it("still appends the cast sheet", async () => {
    const { buildImagePrompts } = await withComposer(true);
    const prompts = buildImagePrompts(project, scene(), cast, undefined, undefined, "flux");
    expect(prompts.startFramePrompt).toContain("Ana");
    expect(prompts.startFramePrompt).toContain("cropped dark hair");
  });

  it("still appends the project look", async () => {
    const { buildImagePrompts } = await withComposer(true);
    const prompts = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    expect(prompts.startFramePrompt).toMatch(/cinematic/i);
    expect(prompts.startFramePrompt).toMatch(/moody/i);
  });

  it("still folds cast traits into the negative prompt", async () => {
    const { buildImagePrompts } = await withComposer(true);
    const prompts = buildImagePrompts(project, scene(), cast, undefined, undefined, "flux");
    expect(prompts.imageNegativePrompt).toContain("beard");
    expect(prompts.imageNegativePrompt).toContain("watermark");
  });

  it("leaves the video negative prompt identical to v1, since routing is unchanged", async () => {
    const on = await withComposer(true);
    const v2 = on.buildVideoPrompts(project, scene(), cast, undefined, undefined, "wan");
    const off = await withComposer(false);
    const v1 = off.buildVideoPrompts(project, scene(), cast, undefined, undefined, "wan");
    expect(v2.videoNegativePrompt).toBe(v1.videoNegativePrompt);
  });

  it("carries the wardrobe-change rule into a scene that depicts one", async () => {
    const { buildImagePrompts } = await withComposer(true);
    const wardrobe = {
      start: { c1: "grey coveralls" },
      end: { c1: "a black coat" },
      within: [{ characterId: "c1", newWardrobe: "a black coat", depictedOnScreen: true }],
      othersStart: {},
      othersEnd: {},
    };
    const prompts = buildImagePrompts(
      project,
      scene(),
      cast,
      undefined,
      wardrobe as never,
      "flux",
    );
    expect(prompts.endFramePrompt).toContain("changed outfit");
  });
});

describe("video composition under the flag", () => {
  it("leads with motion rather than the static description", async () => {
    const { buildVideoPrompts } = await withComposer(true);
    const prompts = buildVideoPrompts(project, scene(), [], undefined, undefined, "wan");
    expect(prompts.videoPromptSegment.startsWith("Over 20 seconds, she seats the gear")).toBe(true);
  });

  it("keeps dialogue verbatim and quoted inline", async () => {
    const { buildVideoPrompts } = await withComposer(true);
    const withLine = scene({
      dialogue: [{ character: "Ana", line: "Then we decide now." }],
    } as Partial<SceneDraft>);
    const prompts = buildVideoPrompts(project, withLine, cast, undefined, undefined, "ltx");
    expect(prompts.videoPromptSegment).toContain('"Then we decide now."');
    expect(prompts.videoPromptSegment).toContain("Lip movement matches");
  });

  it("keeps the identity-preservation clause", async () => {
    const { buildVideoPrompts } = await withComposer(true);
    const prompts = buildVideoPrompts(project, scene(), [], undefined, undefined, "wan");
    expect(prompts.videoPromptSegment).toContain("Preserve subject identity");
  });

  it("produces no duplicated sentence or punctuation artifact end to end", async () => {
    const { buildImagePrompts, buildVideoPrompts } = await withComposer(true);
    const { hasPunctuationArtifact } = await import("@/lib/agents/media-prompt-spec");
    const image = buildImagePrompts(project, scene(), cast, undefined, undefined, "flux");
    const video = buildVideoPrompts(project, scene(), cast, undefined, undefined, "wan");
    for (const text of [
      image.startFramePrompt,
      image.endFramePrompt,
      video.videoPromptSegment,
    ]) {
      expect(hasPunctuationArtifact(text), text.slice(0, 60)).toBe(false);
    }
  });
});
