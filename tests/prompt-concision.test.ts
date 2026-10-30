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

  it("keeps a too-long clip prompt, trimmed, rather than replacing it with the card", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider(undefined, [
      { ...videoAnswer, videoPromptSegment: `${motion} ${padding}` },
    ]);
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake, {
      onExecution: (execution) => executions.push(execution),
    });
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "video")[1]!.system).toMatch(/at most \d+ words/);
    expect(executions.find((e) => e.artifact.endsWith(".video_prompt"))).toMatchObject({
      source: "hybrid", status: "ok", detail: "found=over_budget; salvaged=trimmed",
    });
    expect(scene!.prompts.videoPromptSegment).toContain("Ben gently holds Ana's right wrist");
    expect(scene!.prompts.videoPromptSegment).not.toContain("detail179");
    expect(
      exceedsPromptBudget(scene!.prompts.videoPromptSegment, "wan", "video", 20),
    ).toBe(false);
  });

  it("puts back a spoken line the model dropped, word for word, instead of falling back", async () => {
    const { project, drafts } = await fixture();
    const draft = { ...drafts[0]!, dialogue: [{ character: "Ana", line: "Ready. Now, go." }] };
    const { fake, calls } = provider(undefined, [videoAnswer]);
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [draft], fake, {
      onExecution: (execution) => executions.push(execution),
    });
    expect(calls.filter((c) => c.kind === "video")[1]!.system).toContain('Ana: "Ready. Now, go."');
    expect(scene!.prompts.videoPromptSegment).toContain('Ana says, "Ready. Now, go."');
    expect(executions.find((e) => e.artifact.endsWith(".video_prompt"))).toMatchObject({
      source: "hybrid", detail: "found=dialogue_dropped; salvaged=dialogue_restored",
    });
  });

  it("accepts a line whose punctuation or case the model changed", async () => {
    const { project, drafts } = await fixture();
    const draft = { ...drafts[0]!, dialogue: [{ character: "Ana", line: "Look at my hips. You want to see them move." }] };
    const { fake, calls } = provider(undefined, [
      { ...videoAnswer, videoPromptSegment: `${motion} Ana says, "look at my hips, you want to see them move"` },
    ]);
    await attachScenePrompts(project, [draft], fake);
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(1);
  });

  it("does not write a clip prompt for a project that never renders video", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider();
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(
      { ...project, generationMode: "keyframes_only" }, [drafts[0]!], fake,
      { onExecution: (execution) => executions.push(execution) },
    );
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "image").length).toBeGreaterThan(0);
    expect(scene!.prompts.videoPromptFamily).toBe("deferred");
    expect(executions.find((e) => e.artifact.endsWith(".video_prompt"))).toMatchObject({
      source: "deterministic", status: "ok", detail: "deferred: this project does not render video",
    });
  });

  it("still writes the clip prompt when the video pass is asked for by name", async () => {
    const { project, drafts } = await fixture();
    const { fake, calls } = provider();
    const [scene] = await attachScenePrompts(
      { ...project, generationMode: "keyframes_only" }, [drafts[0]!], fake,
      { passes: ["video"] },
    );
    expect(calls.filter((c) => c.kind === "video")).toHaveLength(1);
    expect(scene!.prompts.videoPromptFamily).not.toBe("deferred");
  });

  it("keeps carried clip prompts when a keyframes-only project is rewritten", async () => {
    const { project, drafts } = await fixture();
    const { fake } = provider();
    const carried = {
      ...buildImagePrompts(project, drafts[0]!),
      videoPromptSegment: "A hand-edited clip prompt.",
      videoNegativePrompt: "flicker",
      promptQualityChecklist: [],
      videoPromptFamily: "wan",
    };
    const [scene] = await attachScenePrompts(
      { ...project, generationMode: "keyframes_only" }, [drafts[0]!], fake,
      { existing: { [drafts[0]!.id]: carried } },
    );
    expect(scene!.prompts.videoPromptSegment).toBe("A hand-edited clip prompt.");
    expect(scene!.prompts.videoPromptFamily).toBe("wan");
  });

  it("counts automatic suffixes in the image ceiling", async () => {
    const { project, drafts } = await fixture();
    project.style = padding;
    const { fake, calls } = provider();
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake, {
      onExecution: (e) => executions.push(e),
    });
    expect(calls.filter((c) => c.kind === "image")).toHaveLength(2);
    // The retry is told how much room the appended text leaves it.
    expect(calls.filter((c) => c.kind === "image")[1]!.system).toMatch(/at most \d+ words/);
    // The automatic suffix alone exceeds the ceiling. Keep the constraints,
    // but report the unresolved budget rather than claiming success.
    expect(executions.find((e) => e.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "hybrid", status: "degraded", detail: "unresolved=over_budget; trimmed=over_budget",
    });
    expect(scene!.prompts.startFramePrompt).toContain("Ben stands directly behind Ana");
  });

  it("reserves automatic additions before the first image call", async () => {
    const { project, drafts } = await fixture();
    project.style = "muted colors and soft directional workshop lighting";
    const { fake, calls } = provider();
    await attachScenePrompts(project, [drafts[0]!], fake);
    const system = calls.find((call) => call.kind === "image")!.system;
    expect(system).toContain("within 120 words");
    const room = Number(system.match(/at most (\d+) words/)?.[1]);
    expect(room).toBeGreaterThanOrEqual(45);
    expect(room).toBeLessThan(120);
    expect(system).toContain("full appearance is appended only as a fallback");
  });

  it("budgets and retries for supporting people even when only one person is pinned", async () => {
    const { project, drafts } = await fixture();
    const ana = {
      id: "ana", name: "Ana", description: "A woman with short curly hair.",
      createdAt: "now", updatedAt: "now",
    };
    const card = "Ana holds a silver clipboard at the table. Two crew members stand beside Ana.";
    const dropped = "Wide shot, eye level. Ana holds a silver clipboard at the table. Exactly one person is in frame.";
    const complete = "Wide shot, eye level. Ana holds a silver clipboard at the table. " +
      "Two crew members in blue overalls stand beside Ana, each holding a separate yellow toolbox. " +
      "Exactly three people are in frame.";
    const pair = (text: string) => ({
      startFramePrompt: text, endFramePrompt: text, imageNegativePrompt: "blur",
    });
    const { fake, calls } = provider([pair(dropped), pair(complete)]);
    const [scene] = await attachScenePrompts(
      { ...project, generationMode: "keyframes_only" },
      [{ ...drafts[0]!, visualDescription: card, actionDescription: card, charactersPresent: ["Ana"] }],
      fake, {
        cast: [ana],
        budgets: { version: 1, imageWords: 200, wordsPerExtraPerson: 50, imageMaxWords: 500, videoWords: 250 },
      },
    );
    const images = calls.filter((call) => call.kind === "image");
    expect(images).toHaveLength(2);
    expect(images[0].system).toContain("within 300 words");
    expect(JSON.parse(images[0].user).frameParticipants.end.people).toBe(3);
    expect(images[1].system).toContain("preserve every distinct person");
    expect(scene!.prompts.endFramePrompt).toContain("Two crew members");
    expect(scene!.prompts.endFramePrompt).toContain("Exactly three people");
  });

  it("keeps a failed population repair visibly unresolved rather than appending a list of names", async () => {
    const { project, drafts } = await fixture();
    const card = "Exactly three people are in frame. Ana holds a silver clipboard at the table.";
    const dropped = "Wide shot, eye level. Ana holds a silver clipboard at the table. Exactly one person is in frame.";
    const { fake } = provider([{
      startFramePrompt: dropped, endFramePrompt: dropped, imageNegativePrompt: "blur",
    }]);
    const executions: ArtifactExecution[] = [];
    await attachScenePrompts(
      { ...project, generationMode: "keyframes_only" },
      [{ ...drafts[0]!, visualDescription: card, actionDescription: card }], fake,
      { onExecution: (execution) => executions.push(execution) },
    );
    expect(executions.find((entry) => entry.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "hybrid", status: "degraded", detail: "unresolved=headcount_mismatch",
    });
  });

  it("trims an over-long model prompt from the end instead of discarding it", async () => {
    const { project, drafts } = await fixture();
    project.style = "";
    project.tone = "";
    const long = `${start} ${Array.from({ length: 60 }, (_, i) => `Extra${i} detail${i} here.`).join(" ")}`;
    const { fake, calls } = provider([{ ...imageAnswer, startFramePrompt: long, endFramePrompt: long }]);
    const executions: ArtifactExecution[] = [];
    const [scene] = await attachScenePrompts(project, [drafts[0]!], fake, {
      onExecution: (e) => executions.push(e),
    });
    expect(calls.filter((c) => c.kind === "image")).toHaveLength(2);
    expect(executions.find((e) => e.artifact.endsWith(".image_prompt"))).toMatchObject({
      source: "hybrid", detail: "trimmed=over_budget",
    });
    for (const prompt of [scene!.prompts.startFramePrompt, scene!.prompts.endFramePrompt]) {
      expect(countWords(prompt)).toBeLessThanOrEqual(wordBudget("flux", "image", 0));
      expect(prompt).toContain("Ben stands directly behind Ana and holds Ana's right wrist");
      expect(prompt).not.toContain("Extra59");
    }
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
