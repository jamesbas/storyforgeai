import { describe, expect, it, vi } from "vitest";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildImagePrompts,
  buildSceneDrafts,
  buildStoryPlan,
  buildVideoPrompts,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { exceedsPromptBudget, visualWordCount } from "@/lib/agents/prompt-concision";
import { countWords, wordBudget } from "@/lib/agents/media-prompt-spec";
import { othersWardrobeSuffix } from "@/lib/agents/wardrobe";
import { createProject } from "@/lib/services/project-service";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

const start =
  "Medium shot, eye level. Ana sits at a table. Ben stands directly behind Ana and holds " +
  "Ana's right wrist. Ana's left hand rests free on the table.";
const end = start.replace("rests free", "lies free");
const motion = "Ben gently holds Ana's right wrist. Ana's left hand stays free on the table. Fixed camera.";
const imageAnswer = { startFramePrompt: start, endFramePrompt: end, imageNegativePrompt: "blur" };
const videoAnswer = { videoPromptSegment: motion, videoNegativePrompt: "flicker", promptQualityChecklist: [] };
const padding = Array.from({ length: 180 }, (_, i) => `detail${i}`).join(" ") + ".";

async function fixture() {
  const project = {
    ...await createProject({
      concept: "Ana and Ben rehearse a rescue demonstration at a table.",
      requestedDurationSeconds: 40,
    }),
    imageModel: "flux2_klein_base_9b",
    videoModel: "wan2_2_i2v_A14B",
    sceneContinuity: "cut" as const,
  };
  const drafts = buildSceneDrafts(
    project, buildStoryPlan(project), buildCreativeBrief(project), buildVisualBible(project),
  ).map((draft) => ({
    ...draft,
    visualDescription: start,
    actionDescription: "Ben holds Ana's right wrist. Ana's left hand rests free on the table.",
    cameraMovement: "Static",
    storyBeat: "They hold the rescue demonstration pose",
    charactersPresent: [],
  }));
  return { project, drafts };
}

function provider(images: unknown[] = [imageAnswer], videos: unknown[] = [videoAnswer]) {
  const calls: { kind: "image" | "video"; system: string; user: string }[] = [];
  const indices = { image: 0, video: 0 };
  const fake: PlanningProvider = {
    name: "concision-test",
    async generateJson(system, user, schema) {
      const kind = system.includes("Image Prompt Agent") ? "image" : "video";
      calls.push({ kind, system, user });
      const answers = kind === "image" ? images : videos;
      return schema.parse(answers[Math.min(indices[kind]++, answers.length - 1)]);
    },
  };
  return { fake, calls };
}

describe("concise prompt generation", () => {
  it("uses short visual budgets without counting quoted speech as visual detail", () => {
    expect(wordBudget("flux", "image", 0)).toBe(120);
    expect(wordBudget("qwen", "image", 0)).toBe(140);
    expect(wordBudget("wan", "video", 20)).toBe(85);
    expect(wordBudget("minimax_ref2va", "video", 20)).toBe(140);
    const text = `${motion} Ana says, "${padding}"`;
    expect(countWords(text)).toBeGreaterThan(wordBudget("wan", "video", 20));
    expect(visualWordCount(text)).toBeLessThan(30);
    expect(exceedsPromptBudget(text, "wan", "video", 20)).toBe(false);
    expect(exceedsPromptBudget(`"${padding}"`, "wan", "video", 20)).toBe(true);
  });

  it("rewrites an oversized image pair without cutting participants or contact constraints", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider([
      { ...imageAnswer, startFramePrompt: `${start} ${padding}` },
      imageAnswer,
    ]);
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake);
    expect(calls.filter((c) => c.kind === "image")).toHaveLength(2);
    expect(countWords(scene!.prompts.startFramePrompt)).toBeLessThanOrEqual(120);
    expect(scene!.prompts.startFramePrompt).toContain("Ben stands directly behind Ana");
    expect(scene!.prompts.startFramePrompt).toContain("Ana's left hand rests free");
    expect(calls[1]!.user).toContain("Previous answer to rewrite");
    expect(calls[1]!.system).toContain("one compatible pose at each instant");
  });

  it("gives the video writer the accepted keyframes, not just the original scene card", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider();
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake);
    const video = calls.find((c) => c.kind === "video")!;
    const payload = JSON.parse(video.user);
    expect(payload.keyframes.start).toBe(scene!.prompts.startFramePrompt);
    expect(payload.keyframes.end).toBe(scene!.prompts.endFramePrompt);
    expect(video.system).toContain("do not repeat full physical or wardrobe descriptions");
    expect(video.system).not.toContain("roughly twenty-five words");
    expect(video.system).toContain("hands and objects have consistent owners");
  });

  it("rewrites oversized video prose and keeps the spoken line verbatim", async () => {
    const { project, drafts } = await fixture();
    const draft = { ...drafts[0]!, dialogue: [{ character: "Ana", line: "My left hand stays free." }] };
    const spoken = `${motion} Ana says, "My left hand stays free."`;
    const { fake, calls } = provider(undefined, [
      { ...videoAnswer, videoPromptSegment: `${spoken} ${padding}` },
      { ...videoAnswer, videoPromptSegment: spoken },
    ]);
    const [scene] = await attachScenePrompts(project, [draft], fake);
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(2);
    expect(scene!.prompts.videoPromptSegment).toContain('"My left hand stays free."');
    expect(exceedsPromptBudget(scene!.prompts.videoPromptSegment, "wan", "video", 20)).toBe(false);
  });

  it("uses the preceding end frame as the endpoint when an opening is inherited", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider();
    const scenes = await attachScenePrompts(
      { ...project, sceneContinuity: "reuse_end_frame" },
      drafts.map((draft) => ({ ...draft, transitionIn: "Continuous" })),
      fake,
    );
    const videoCalls = calls.filter((c) => c.kind === "video");
    const payload = JSON.parse(videoCalls[1]!.user);
    expect(payload.keyframes.start).toBe(scenes[0]!.prompts.endFramePrompt);
    expect(payload.keyframes.end).toBe(scenes[1]!.prompts.endFramePrompt);
  });

  it("also retries a short answer that dropped dialogue", async () => {
    const { project, drafts } = await fixture();
    const draft = { ...drafts[0]!, dialogue: [{ character: "Ana", line: "Ready." }] };
    const { fake, calls } = provider(undefined, [
      videoAnswer,
      { ...videoAnswer, videoPromptSegment: `${motion} Ana says, "Ready."` },
    ]);
    const [scene] = await attachScenePrompts(project, [draft], fake);
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(2);
    expect(scene!.prompts.videoPromptSegment).toContain('"Ready."');
  });

  it("records a degraded fallback when shortening fails rather than silently truncating", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider(undefined, [
      { ...videoAnswer, videoPromptSegment: `${motion} ${padding}` },
    ]);
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake, {
      onExecution: (execution) => executions.push(execution),
    });
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(2);
    expect(executions.find((e) => e.artifact.endsWith(".video_prompt"))).toMatchObject({
      source: "deterministic", status: "degraded", fallbackReason: "invalid_set",
    });
    expect(scene!.prompts.videoPromptSegment).toContain("Ana's left hand rests free");
  });

  it("counts automatic suffixes in the image ceiling", async () => {
    const { project, drafts } = await fixture();
    project.style = padding;
    const { fake, calls } = provider();
    const executions: ArtifactExecution[] = [];
    await attachScenePrompts(project, [drafts[0]!], fake, {
      onExecution: (e) => executions.push(e),
    });
    expect(calls.filter((c) => c.kind === "image")).toHaveLength(2);
    expect(executions.find((e) => e.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "deterministic", fallbackReason: "invalid_set",
    });
  });

  it("counts framing repairs in the final image ceiling when the composer is enabled", async () => {
    const { project, drafts } = await fixture();
    project.style = "";
    project.tone = "";
    const body = start.replace("Medium shot, eye level. ", "");
    const nearBudget = `${body} ${Array.from(
      { length: 118 - countWords(body) }, (_, i) => `detail${i}`,
    ).join(" ")}.`;
    const { fake, calls } = provider([
      { ...imageAnswer, startFramePrompt: nearBudget },
      imageAnswer,
    ]);
    vi.stubEnv("MEDIA_PROMPT_COMPOSER_V2", "true");
    vi.resetModules();
    try {
      const { attachScenePrompts: attachWithComposer } = await import("@/lib/agents/prompt-agents");
      const [scene] = await attachWithComposer(project, [drafts[0]!], fake);
      expect(calls.filter((c) => c.kind === "image")).toHaveLength(2);
      expect(countWords(scene!.prompts.startFramePrompt)).toBeLessThanOrEqual(120);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not reintroduce full appearance, style or extra camera blocks in fallback clips", async () => {
    const { project, drafts } = await fixture();
    const scene = drafts[0]!;
    const prompt = buildVideoPrompts(project, scene).videoPromptSegment;
    expect(prompt).not.toContain(scene.visualDescription);
    expect(prompt).not.toContain("Scene intent:");
    expect(prompt).not.toContain("Shot plan:");
    expect(prompt).not.toContain("Art direction:");
    expect(prompt).not.toContain("cinematic style");
    expect(prompt).toContain("Ana's left hand rests free");
    expect(prompt.match(/Preserve subject identity/g)).toHaveLength(1);
    expect(buildImagePrompts(project, scene).startFramePrompt).not.toContain(scene.storyBeat);
  });
});

describe("wardrobe stated once, with its owner", () => {
  it("does not append an outfit already bound to the same person", () => {
    expect(othersWardrobeSuffix(
      { "the guide": "a blue jacket" }, "The guide in a blue jacket stands behind Ana.",
    )).toBe("");
  });

  it("does not borrow an outfit stated for another person", () => {
    expect(othersWardrobeSuffix(
      { "the guide": "a blue jacket" }, "The guide stands behind Ana. Ana wears a blue jacket.",
    )).toContain("the guide is dressed in a blue jacket");
  });
});
