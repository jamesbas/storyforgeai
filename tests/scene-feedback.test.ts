import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPlanningProvider,
  type PlanningProvider,
} from "@/lib/agents/llm/provider";
import { feedbackPatch, SCENE_FEEDBACK_SYSTEM } from "@/lib/agents/scene-feedback";
import { repository } from "@/lib/db/store";
import { sceneFeedbackRequestSchema, type SceneFeedbackProposal } from "@/lib/schemas/scene-feedback";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { createProject, generateStoryboard, getProjectRecord, updateScenePrompts } from "@/lib/services/project-service";
import { applySceneFeedback, previewSceneFeedback } from "@/lib/services/scene-feedback-service";
import { getAgentRun, resetAgentRuns, trackAgentRun } from "@/lib/services/agent-runs";
import { getQueue } from "@/lib/services/scene-queue";
import { POST, PUT } from "@/app/api/projects/[projectId]/scenes/[sceneId]/feedback/route";

vi.mock("@/lib/agents/llm/provider", async (original) => ({
  ...await original<typeof import("@/lib/agents/llm/provider")>(),
  getPlanningProvider: vi.fn(() => null),
}));
vi.mock("@/lib/services/scene-queue", () => ({
  getQueue: vi.fn(() => ({ active: false, entries: [], remaining: 0 })),
}));

const start = "Medium shot, eye level. Mara stands beside a table, her left hand resting on its edge.";
const end = "Medium shot, eye level. Mara stands beside the table with the cup still on the table.";
const revisedEnd = "Medium shot, eye level. Mara stands beside the table holding the cup in her left hand.";
const video = "Mara slowly raises her right hand while the cup remains on the table. Fixed camera, unchanged framing.";
const revisedVideo = "Mara slowly picks up the cup in her left hand and holds it. Fixed camera, unchanged framing.";
const edit = `Edit the supplied reference frame. Desired final still state: ${end}`;
const revisedEdit = `Edit the supplied reference frame. Desired final still state: ${revisedEnd}`;

function proposal(revisions: SceneFeedbackProposal["revisions"] = [
  { field: "endFramePrompt", after: revisedEnd, reason: "Put the cup in her left hand." },
  { field: "endFrameEditPrompt", after: revisedEdit, reason: "Make the edit reach the new destination." },
  { field: "videoPromptSegment", after: revisedVideo, reason: "The motion now reaches the new end frame." },
], videoChanged = true): SceneFeedbackProposal {
  return {
    summary: "Mara picks up the cup with her left hand.",
    revisions,
    videoReview: {
      needsChange: videoChanged,
      explanation: videoChanged ? "The old motion left the cup on the table; it now reaches her hand." : "The existing motion still connects the two frames.",
    },
  };
}

function model(answer: unknown = proposal()): PlanningProvider {
  return {
    name: "test-feedback",
    generateJson: vi.fn(async (_system, _user, schema) => answer === null ? null : schema.parse(answer)),
  };
}

async function seeded(continuity: "cut" | "reuse_end_frame" = "cut", videoEnabled = true): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "Mara picks up a cup from the table.",
    requestedDurationSeconds: 30,
    sceneContinuity: continuity,
    generationMode: videoEnabled ? "video_segments" : "keyframes_only",
  });
  const record = await generateStoryboard(project.id);
  const scenes = record.storyboard!.scenes.map((scene, index) => ({
    ...scene,
    title: `Cup ${index + 1}`,
    visualDescription: "Mara stands beside a table with a cup.",
    actionDescription: "Mara stands beside the table and picks up the cup.",
    cameraMovement: "Static",
    charactersPresent: [],
    frameVisibility: { start: ["Mara"], end: ["Mara"] },
    prompts: {
      ...scene.prompts,
      startFramePrompt: index === 1 && continuity === "reuse_end_frame" ? end : start,
      endFramePrompt: end,
      endFrameEditPrompt: edit,
      videoPromptSegment: video,
      videoPromptFamily: videoEnabled ? "wan" : "deferred",
    },
  }));
  const updated = {
    ...record,
    project: { ...record.project, sceneSeeds: { [scenes[0]!.id]: 12345 } },
    attempts: {
      [scenes[0]!.id]: [{
        id: "kept-attempt", sceneId: scenes[0]!.id, attemptNumber: 1,
        startImagePath: "kept-start.png", endImagePath: "kept-end.png", videoPath: "kept-clip.mp4",
        settingsIds: ["kept-settings"], approved: true, createdAt: "2026-11-10T12:00:00.000Z",
      }],
    },
    previews: {
      [scenes[0]!.id]: { endFramePath: "kept-preview.png", updatedAt: "2026-11-10T12:00:00.000Z" },
    },
    storyboard: { ...record.storyboard!, visualBible: { ...record.storyboard!.visualBible, characters: [] }, scenes },
  };
  await repository.update(project.id, updated);
  return updated;
}

beforeEach(() => {
  resetAgentRuns();
  vi.mocked(getPlanningProvider).mockReturnValue(null);
  vi.mocked(getQueue).mockReturnValue({ active: false, entries: [], remaining: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("human feedback proposals", () => {
  it("uses the current scene, both prompts, people, story, neighbours and human feedback without sending images or saving", async () => {
    const record = await seeded();
    const provider = model();
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, {
      scope: "end", feedback: "The cup is in the wrong place. Put it in her left hand.",
    });
    expect(await getProjectRecord(record.project.id)).toEqual(record);
    expect(getAgentRun(record.project.id)).toBeNull();
    expect(preview.changes.map((change) => change.field)).toEqual([
      "endFramePrompt", "endFrameEditPrompt", "videoPromptSegment",
    ]);
    expect(preview.proposal.videoReview.needsChange).toBe(true);
    const call = vi.mocked(provider.generateJson).mock.calls[0]!;
    expect(call[0]).toContain(SCENE_FEEDBACK_SYSTEM);
    expect(JSON.parse(call[1])).toMatchObject({
      scope: "end",
      feedback: "The cup is in the wrong place. Put it in her left hand.",
      context: {
        scene: { sceneNumber: 1, actionDescription: scene.actionDescription },
        prompts: { startFramePrompt: start, endFramePrompt: end, videoPromptSegment: video },
        people: expect.any(Array), wardrobe: expect.any(Object), story: expect.any(Object),
        neighbours: { next: { sceneNumber: 2 } },
      },
    });
    expect(JSON.parse(call[1]).context.frames).toBeUndefined();
    expect(call[3]).toEqual({ systemPromptScope: "render_prompts" });
  });

  it("saves all dependent changes together through prompt editing, preserving other scenes, negative prompts, attempts, seeds and history", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Put the cup in her left hand." });
    const after = await applySceneFeedback(record.project.id, scene.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    });
    const saved = after.storyboard!.scenes[0]!;
    expect(saved.prompts).toMatchObject({
      startFramePrompt: start, endFramePrompt: revisedEnd, endFrameEditPrompt: revisedEdit,
      videoPromptSegment: revisedVideo,
      imageNegativePrompt: scene.prompts.imageNegativePrompt,
      videoNegativePrompt: scene.prompts.videoNegativePrompt,
    });
    expect(after.storyboard!.scenes.slice(1)).toEqual(record.storyboard!.scenes.slice(1));
    expect(after.attempts).toEqual(record.attempts);
    expect(after.previews).toEqual(record.previews);
    expect(after.project.sceneSeeds).toEqual(record.project.sceneSeeds);
    expect(after.history!.at(-1)?.action).toBe("scene.prompts_edited");
    expect(await getProjectRecord(record.project.id)).toEqual(after);
    expect(getQueue(record.project.id).active).toBe(false);
  });

  it("previews and saves the next scene's carried opening, but preserves a planned cut", async () => {
    const record = await seeded("reuse_end_frame");
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold the cup." });
    expect(preview.changes).toContainEqual(expect.objectContaining({
      sceneId: record.storyboard!.scenes[1]!.id, field: "startFramePrompt", after: revisedEnd, carried: true,
    }));
    expect(preview.warnings).toContainEqual(expect.stringContaining("other prompts are not rewritten"));
    const after = await applySceneFeedback(record.project.id, scene.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    });
    expect(after.storyboard!.scenes[1]!.prompts.startFramePrompt).toBe(revisedEnd);
    expect(after.storyboard!.scenes[1]!.prompts.endFramePrompt).toBe(end);
  });

  it.each(["start", "end", "keyframes", "video"] as const)("limits primary changes to the chosen %s scope", async (scope) => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    const frameField = scope === "start" ? "startFramePrompt" : "endFramePrompt";
    const revisions: SceneFeedbackProposal["revisions"] = scope === "video" ? [
      { field: "videoPromptSegment", after: revisedVideo, reason: "Fix the motion." },
    ] : [
      { field: frameField, after: revisedEnd, reason: "Fix the frame." },
      { field: "endFrameEditPrompt", after: revisedEdit, reason: "Review the dependent edit." },
    ];
    vi.mocked(getPlanningProvider).mockReturnValue(model(proposal(revisions, scope === "video")));
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope, feedback: "Fix the hand and cup." });
    const fields = preview.changes.map((change) => change.field);
    const untouched = scope === "start" ? "endFramePrompt" : "startFramePrompt";
    expect(fields).not.toContain(untouched);
    expect(preview.proposal.videoReview.needsChange).toBe(scope === "video");
  });

  it("rejects a stale preview even if an unmodified dependent prompt was changed", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold the cup." });
    await updateScenePrompts(record.project.id, scene.id, { startFramePrompt: "Medium shot. A new opening." });
    const beforeApply = await getProjectRecord(record.project.id);
    await expect(applySceneFeedback(record.project.id, scene.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    })).rejects.toThrow(/changed after this preview/i);
    expect(await getProjectRecord(record.project.id)).toEqual(beforeApply);
  });

  it("binds a preview to its scene rather than allowing it to be applied to another scene", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const preview = await previewSceneFeedback(record.project.id, record.storyboard!.scenes[0]!.id, { scope: "end", feedback: "Hold the cup." });
    await expect(applySceneFeedback(record.project.id, record.storyboard!.scenes[1]!.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    })).rejects.toThrow(/changed after this preview/i);
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });

  it("rechecks the latest record at save time rather than overwriting an intervening manual edit", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold the cup." });
    const get = repository.get.bind(repository);
    let reads = 0;
    vi.spyOn(repository, "get").mockImplementation(async (id) => {
      if (id === record.project.id && ++reads === 3) {
        const intervening = {
          ...record,
          storyboard: { ...record.storyboard!, scenes: record.storyboard!.scenes.map((s) => s.id !== scene.id ? s : {
            ...s, prompts: { ...s.prompts, startFramePrompt: "Medium shot. The manual opening edit." },
          }) },
        };
        await repository.update(id, intervening);
        return intervening;
      }
      return get(id);
    });
    await expect(applySceneFeedback(record.project.id, scene.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    })).rejects.toThrow(/changed after this preview/i);
    expect((await getProjectRecord(record.project.id)).storyboard!.scenes[0]!.prompts.startFramePrompt)
      .toBe("Medium shot. The manual opening edit.");
  });

  it("rebuilds character continuity once and previews exactly the text that will be saved", async () => {
    const record = await seeded();
    record.storyboard!.visualBible.characters = [{
      name: "Mara", description: "A Black woman with dark brown skin and short black hair.",
    }];
    await repository.update(record.project.id, record);
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold the cup." });
    const endChange = preview.changes.find((change) => change.field === "endFramePrompt")!;
    expect(endChange.after).toContain("dark brown skin");
    expect(endChange.after.match(/Character continuity/g)).toHaveLength(1);
    const saved = await applySceneFeedback(record.project.id, scene.id, {
      scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal,
    });
    expect(saved.storyboard!.scenes[0]!.prompts.endFramePrompt).toBe(endChange.after);
  });

  it("supports keyframes-only projects without pretending a clip was reviewed", async () => {
    const record = await seeded("cut", false);
    const answer = proposal([
      { field: "endFramePrompt", after: revisedEnd, reason: "Hold the cup." },
      { field: "endFrameEditPrompt", after: revisedEdit, reason: "Match the end state." },
    ], false);
    answer.videoReview.explanation = "This project renders keyframes only.";
    const provider = model(answer);
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold the cup." });
    expect(preview.changes.some((change) => change.field.startsWith("video"))).toBe(false);
    expect(JSON.parse(vi.mocked(provider.generateJson).mock.calls[0]![1]).context.prompts.videoPromptSegment).toBeUndefined();
    await expect(previewSceneFeedback(record.project.id, scene.id, { scope: "video", feedback: "Hold the cup." })).rejects.toThrow(/no active video prompt/);
  });

  it("reports missing or failed models explicitly and leaves the record untouched", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    await expect(previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold it." })).rejects.toThrow(/requires AI planning/);
    vi.mocked(getPlanningProvider).mockReturnValue(model(null));
    await expect(previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold it." })).rejects.toThrow(/no usable feedback proposal/);
    expect(await getProjectRecord(record.project.id)).toEqual(record);
    expect(getAgentRun(record.project.id)).toBeNull();
  });

  it("does not start while rendering or planning is active", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    vi.mocked(getQueue).mockReturnValue({ active: true, entries: [], remaining: 1 });
    await expect(previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold it." })).rejects.toThrow(/Wait for/);
    vi.mocked(getQueue).mockReturnValue({ active: false, entries: [], remaining: 0 });
    await trackAgentRun(record.project.id, "test", "Test", async () => {
      await expect(previewSceneFeedback(record.project.id, scene.id, { scope: "end", feedback: "Hold it." })).rejects.toThrow(/Wait for/);
    });
  });

  it("bounds and validates user input before contacting a model", () => {
    expect(sceneFeedbackRequestSchema.safeParse({ scope: "end", feedback: "  " }).success).toBe(false);
    expect(sceneFeedbackRequestSchema.safeParse({ scope: "end", feedback: "x".repeat(4001) }).success).toBe(false);
    expect(sceneFeedbackRequestSchema.safeParse({ scope: "all", feedback: "Hold it." }).success).toBe(false);
  });
});

describe("proposal contracts", () => {
  it("can revise both keyframes and their dependent edit and video in one proposal", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    const answer = proposal([
      { field: "startFramePrompt", after: "Medium shot. Mara holds her left hand above the cup.", reason: "Set up the pickup." },
      ...proposal().revisions,
    ]);
    expect(feedbackPatch(scene, "keyframes", answer, true)).toMatchObject({
      startFramePrompt: answer.revisions[0]!.after,
      endFramePrompt: revisedEnd,
      endFrameEditPrompt: revisedEdit,
      videoPromptSegment: revisedVideo,
    });
  });

  it("rejects opposite frames, duplicate fields, forgotten edits, inconsistent video impact, and no-op proposals", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    const cases: SceneFeedbackProposal[] = [
      proposal([{ field: "startFramePrompt", after: revisedEnd, reason: "Wrong scope." }], false),
      proposal([...proposal().revisions, proposal().revisions[0]!]),
      proposal(proposal().revisions.filter((revision) => revision.field !== "endFrameEditPrompt")),
      proposal(proposal().revisions.map((revision) =>
        revision.field === "endFrameEditPrompt" ? { ...revision, after: edit } : revision)),
      { ...proposal(), videoReview: { needsChange: false, explanation: "No impact." } },
      proposal([{ field: "endFramePrompt", after: end, reason: "No change." }], false),
    ];
    for (const answer of cases) expect(() => feedbackPatch(scene, "end", answer, true)).toThrow();
  });

  it("keeps a reviewed, unchanged end edit when only the opening changes", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    const answer = proposal([
      { field: "startFramePrompt", after: revisedEnd, reason: "New opening state." },
      { field: "endFrameEditPrompt", after: edit, reason: "Reviewed." },
    ], false);
    expect(feedbackPatch(scene, "start", answer, true).endFrameEditPrompt).toBe(edit);
  });

  it("preserves Fibo caption/edit shapes and rejects broken structured prompts", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    scene.prompts.endFramePrompt = JSON.stringify({ short_description: end });
    const answer = (after: string) => proposal([
      { field: "endFramePrompt", after, reason: "Hold the cup." },
      { field: "endFrameEditPrompt", after: revisedEdit, reason: "Edit the supplied frame." },
    ], false);
    expect(() => feedbackPatch(scene, "end", answer(revisedEnd), true)).toThrow(/structured keyframe/);
    expect(() => feedbackPatch(scene, "end", answer('{"short_description":'), true)).toThrow(/Invalid Fibo/);
    const json = JSON.stringify({ short_description: revisedEnd });
    expect(feedbackPatch(scene, "end", answer(json), true).endFramePrompt).toBe(json);
  });

  it("requires the revised video to preserve the scene's spoken dialogue", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    scene.dialogue = [{ character: "Mara", line: "This is my cup." }];
    expect(() => feedbackPatch(scene, "video", proposal([
      { field: "videoPromptSegment", after: revisedVideo, reason: "Hold the cup." },
    ]), true)).toThrow(/dialogue/);
  });

  it("preserves structured video sections instead of silently turning H3 prompts into prose", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    scene.prompts.videoPromptSegment = "integrated_multimodal_description: Mara picks up a cup.\noverall_soundscape: Quiet.\nnon_diegetic_music: N/A";
    expect(() => feedbackPatch(scene, "video", proposal([
      { field: "videoPromptSegment", after: revisedVideo, reason: "New motion." },
    ]), true)).toThrow(/section labels/);
  });

  it("can clear an existing score without allowing an empty visual or motion prompt", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    scene.prompts.videoScore = "Soft piano";
    expect(feedbackPatch(scene, "video", proposal([
      { field: "videoScore", after: "", reason: "Remove the music as requested." },
    ]), true).videoScore).toBe("");
    expect(() => feedbackPatch(scene, "video", proposal([
      { field: "videoPromptSegment", after: "", reason: "Empty." },
    ]), true)).toThrow(/cannot be empty/);
  });

  it("retries an out-of-scope answer once with corrective feedback and never saves it", async () => {
    const record = await seeded();
    const provider = model();
    vi.mocked(provider.generateJson).mockResolvedValueOnce(proposal([
      { field: "startFramePrompt", after: revisedEnd, reason: "Wrong frame." },
    ], false));
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    await previewSceneFeedback(record.project.id, record.storyboard!.scenes[0]!.id, { scope: "end", feedback: "Hold the cup." });
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(provider.generateJson).mock.calls[1]![1]).correction).toContain("outside the chosen scope");
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });
});

describe("feedback API", () => {
  it("previews with POST and persists only on PUT; responses cannot be cached", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const props = { params: Promise.resolve({ projectId: record.project.id, sceneId: record.storyboard!.scenes[0]!.id }) };
    const previewResponse = await POST(new Request("http://localhost/feedback", {
      method: "POST", body: JSON.stringify({ scope: "end", feedback: "Hold the cup." }),
    }), props);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(await getProjectRecord(record.project.id)).toEqual(record);
    const preview = await previewResponse.json();
    const applyResponse = await PUT(new Request("http://localhost/feedback", {
      method: "PUT", body: JSON.stringify({ scope: preview.scope, sourceHash: preview.sourceHash, proposal: preview.proposal }),
    }), props);
    expect(applyResponse.status).toBe(200);
    expect((await applyResponse.json()).storyboard.scenes[0].prompts.endFramePrompt).toBe(revisedEnd);
  });

  it("returns explicit validation and missing-model errors", async () => {
    const record = await seeded();
    const props = { params: Promise.resolve({ projectId: record.project.id, sceneId: record.storyboard!.scenes[0]!.id }) };
    const invalid = await POST(new Request("http://localhost/feedback", {
      method: "POST", body: JSON.stringify({ scope: "end", feedback: "" }),
    }), props);
    expect(invalid.status).toBe(400);
    const unavailable = await POST(new Request("http://localhost/feedback", {
      method: "POST", body: JSON.stringify({ scope: "end", feedback: "Hold it." }),
    }), props);
    expect(unavailable.status).toBe(409);
  });
});
