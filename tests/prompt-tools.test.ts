import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addImagePromptText,
  applySimplifiedPrompts,
  previewSimplifiedPrompts,
} from "@/lib/services/prompt-tools-service";
import { createProject, generateStoryboard, getProjectRecord, updateScenePrompts } from "@/lib/services/project-service";
import { getPlanningProvider, type PlanningProvider } from "@/lib/agents/llm/provider";
import { SIMPLIFY_PROMPT_SYSTEM, simplifyPrompt } from "@/lib/agents/prompt-simplifier";
import { countWords } from "@/lib/agents/media-prompt-spec";
import { getQueue } from "@/lib/services/scene-queue";
import { trackAgentRun } from "@/lib/services/agent-runs";
import { repository } from "@/lib/db/store";
import type { SimplifiedPrompt } from "@/lib/schemas/prompt-tools";
import type { Scene } from "@/lib/schemas/storyboard";
import { POST as addRoute } from "@/app/api/projects/[projectId]/prompts/add-text/route";
import { POST as previewRoute, PATCH as applyRoute } from "@/app/api/projects/[projectId]/prompts/simplify/route";

vi.mock("@/lib/agents/llm/provider", async (original) => ({
  ...await original<typeof import("@/lib/agents/llm/provider")>(),
  getPlanningProvider: vi.fn(() => null),
}));
vi.mock("@/lib/services/scene-queue", () => ({
  getQueue: vi.fn(() => ({ active: false, entries: [], remaining: 0 })),
}));

const originalStart = "Mara stands beside the red door, with her right hand resting on the brass handle in warm light.";
const shorter = "Mara stands beside the red door, right hand on its handle.";

function model(answer: (user: string) => unknown = () => ({ prompt: shorter })): PlanningProvider {
  return {
    name: "test",
    generateJson: vi.fn(async (_system, user, schema) => schema.parse(answer(user))),
  };
}

async function seeded() {
  const project = await createProject({
    concept: "Mara opens a red door and walks into a courtyard.",
    requestedDurationSeconds: 60,
  });
  const record = await generateStoryboard(project.id);
  for (const scene of record.storyboard!.scenes) {
    await updateScenePrompts(project.id, scene.id, {
      startFramePrompt: originalStart,
      endFramePrompt: "Mara stands in the bright courtyard, facing the fountain, with her right hand resting on a wooden gate.",
      videoPromptSegment: "Mara starts beside the red door, opens it with her right hand, and walks forward into the courtyard to stop by the fountain.",
    });
  }
  return getProjectRecord(project.id);
}

beforeEach(() => {
  vi.mocked(getPlanningProvider).mockReturnValue(null);
  vi.mocked(getQueue).mockReturnValue({ active: false, entries: [], remaining: 0 });
});

describe("bulk literal image prompt additions", () => {
  it.each(["start", "end", "both"] as const)("appends only to %s frames on selected scenes", async (frames) => {
    const record = await seeded();
    const [first, second, third] = record.storyboard!.scenes;
    const text = "A small blue sign reads OPEN.";
    const after = await addImagePromptText(record.project.id, {
      scope: "selected", sceneIds: [first!.id, third!.id, first!.id],
      frames, placement: "append", text,
    });
    after.storyboard!.scenes.forEach((scene, index) => {
      const before = record.storyboard!.scenes[index]!;
      const chosen = scene.id !== second!.id;
      expect(scene).toEqual({
        ...before,
        prompts: {
          ...before.prompts,
          startFramePrompt: chosen && frames !== "end" ? `${before.prompts.startFramePrompt}\n${text}` : before.prompts.startFramePrompt,
          endFramePrompt: chosen && frames !== "start" ? `${before.prompts.endFramePrompt}\n${text}` : before.prompts.endFramePrompt,
        },
      });
    });
    expect(after.attempts).toEqual(record.attempts);
    expect(after.executions).toEqual(record.executions);
    expect(after.project.sceneSeeds).toEqual(record.project.sceneSeeds);
    expect(getPlanningProvider).not.toHaveReturnedWith(expect.objectContaining({ name: "test" }));
    expect(after.history!.slice(record.history!.length).map((entry) => entry.detail)).toEqual(["Scene 1", "Scene 3"]);
    expect(await getProjectRecord(record.project.id)).toEqual(after);
  });

  it("prepends literal multiline text to every scene when explicitly requested", async () => {
    const record = await seeded();
    const text = "Keep the red door.\nThe brass handle catches the light.";
    const after = await addImagePromptText(record.project.id, {
      scope: "all", placement: "prepend", text,
    });
    for (const scene of after.storyboard!.scenes) {
      expect(scene.prompts.startFramePrompt).toBe(`${text}\n${originalStart}`);
    }
  });

  it.each([
    { scope: "selected", sceneIds: [], placement: "append", text: "extra" },
    { scope: "selected", sceneIds: ["missing"], placement: "append", text: "extra" },
    { scope: "all", placement: "append", text: "  " },
    { scope: "all", placement: "replace", text: "extra" },
    { scope: "all", frames: "video", placement: "append", text: "extra" },
  ])("rejects invalid additions without saving: %j", async (input) => {
    const record = await seeded();
    await expect(addImagePromptText(record.project.id, input)).rejects.toThrow();
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });

  it("validates all combined lengths before saving any scene", async () => {
    const record = await seeded();
    await updateScenePrompts(record.project.id, record.storyboard!.scenes[1]!.id, { endFramePrompt: "x".repeat(8000) });
    const before = await getProjectRecord(record.project.id);
    await expect(addImagePromptText(record.project.id, { scope: "all", placement: "append", text: "extra" })).rejects.toThrow();
    expect(await getProjectRecord(record.project.id)).toEqual(before);
  });
});

describe("simplification previews and selective application", () => {
  it.each([
    ["image", "start", 1],
    ["image", "end", 1],
    ["image", "both", 2],
    ["video", "both", 1],
    ["both", "both", 3],
  ] as const)("previews %s / %s only, without saving", async (target, frames, count) => {
    const record = await seeded();
    const provider = model();
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const scene = record.storyboard!.scenes[1]!;
    const preview = await previewSimplifiedPrompts(record.project.id, {
      scope: "selected", sceneIds: [scene.id], target, frames,
    });
    expect(preview.results).toHaveLength(count);
    expect(provider.generateJson).toHaveBeenCalledTimes(count);
    for (const result of preview.results) {
      expect(result.sceneId).toBe(scene.id);
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(countWords(result.after)).toBeLessThan(countWords(result.before));
        expect(result.after.length).toBeLessThan(result.before.length);
      }
    }
    expect(await getProjectRecord(record.project.id)).toEqual(record);
    const call = vi.mocked(provider.generateJson).mock.calls[0]!;
    expect(call[0]).toBe(SIMPLIFY_PROMPT_SYSTEM);
    expect(JSON.parse(call[1])).toMatchObject({
      currentPrompt: scene.prompts[preview.results[0]!.field],
      startFrame: scene.prompts.startFramePrompt,
      endFrame: scene.prompts.endFramePrompt,
      sceneCard: { actionDescription: scene.actionDescription },
    });
    expect(call[3]).toEqual({ systemPromptScope: "render_prompts" });
  });

  it("previews all scenes, then applies only checked fields preserving unrelated updates", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const preview = await previewSimplifiedPrompts(record.project.id, { scope: "all", target: "both" });
    expect(preview.results).toHaveLength(record.storyboard!.scenes.length * 3);
    const chosen = preview.results.filter((row): row is SimplifiedPrompt =>
      row.status === "ready" && row.sceneId === record.storyboard!.scenes[0]!.id && row.field !== "endFramePrompt");
    const changed = await updateScenePrompts(record.project.id, record.storyboard!.scenes[1]!.id, {
      imageNegativePrompt: "keep this unrelated edit",
    });
    const after = await applySimplifiedPrompts(record.project.id, { results: chosen });
    expect(after.storyboard!.scenes[0]!.prompts).toEqual({
      ...record.storyboard!.scenes[0]!.prompts, startFramePrompt: shorter, videoPromptSegment: shorter,
    });
    expect(after.storyboard!.scenes.slice(1)).toEqual(changed.storyboard!.scenes.slice(1));
    expect(after.attempts).toEqual(record.attempts);
    expect(after.executions).toEqual(record.executions);
    expect(await getProjectRecord(record.project.id)).toEqual(after);
  });

  it("rejects a stale preview atomically, even when only a later result changed", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const preview = await previewSimplifiedPrompts(record.project.id, { scope: "all", target: "image" });
    const changed = await updateScenePrompts(record.project.id, record.storyboard!.scenes[1]!.id, { startFramePrompt: "Newer hand edit." });
    await expect(applySimplifiedPrompts(record.project.id, { results: preview.results })).rejects.toThrow(/changed since this preview/);
    expect(await getProjectRecord(record.project.id)).toEqual(changed);
  });

  it("rejects empty selections, unknown scenes, duplicate fields and non-shorter results", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    await expect(previewSimplifiedPrompts(record.project.id, { scope: "selected", sceneIds: [], target: "image" })).rejects.toThrow();
    await expect(previewSimplifiedPrompts(record.project.id, { scope: "selected", sceneIds: ["missing"], target: "image" })).rejects.toThrow(/not found/);
    await expect(applySimplifiedPrompts(record.project.id, { results: [] })).rejects.toThrow();
    const preview = await previewSimplifiedPrompts(record.project.id, { scope: "all", target: "image" });
    const row = preview.results[0]!;
    await expect(applySimplifiedPrompts(record.project.id, { results: [row, row] })).rejects.toThrow(/more than once/);
    await expect(applySimplifiedPrompts(record.project.id, { results: [{ ...row, after: row.before }] })).rejects.toThrow(/shorter/);
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });

  it("requires a real planning provider rather than claiming a fallback is simplified", async () => {
    const record = await seeded();
    await expect(previewSimplifiedPrompts(record.project.id, { scope: "all", target: "image" })).rejects.toThrow(/configured planning model/);
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });

  it("reports failed prompts explicitly and keeps successful preview rows", async () => {
    const record = await seeded();
    const provider = model((user) => {
      const { frame } = JSON.parse(user) as { frame: string };
      return frame === "startFramePrompt" ? { prompt: shorter } : { prompt: "" };
    });
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const preview = await previewSimplifiedPrompts(record.project.id, {
      scope: "selected", sceneIds: [record.storyboard!.scenes[0]!.id], target: "image",
    });
    expect(preview.results.map((row) => row.status)).toEqual(["ready", "error"]);
    expect(await getProjectRecord(record.project.id)).toEqual(record);
  });

  it("refuses bulk changes during generation or planning", async () => {
    const record = await seeded();
    vi.mocked(getQueue).mockReturnValue({ active: true, entries: [], remaining: 1 });
    await expect(addImagePromptText(record.project.id, { scope: "all", placement: "append", text: "extra" })).rejects.toThrow(/current generation/);
    vi.mocked(getQueue).mockReturnValue({ active: false, entries: [], remaining: 0 });
    await trackAgentRun(record.project.id, "storyboard", "Storyboard", async () => {
      await expect(previewSimplifiedPrompts(record.project.id, { scope: "all", target: "video" })).rejects.toThrow(/current generation/);
    });
  });

  it("requires a storyboard", async () => {
    const project = await createProject({ concept: "A courier opens a door.", requestedDurationSeconds: 20 });
    await expect(addImagePromptText(project.id, { scope: "all", placement: "append", text: "extra" })).rejects.toThrow(/Generate a storyboard/);
  });
});

describe("simplification quality contract", () => {
  it("retries a non-shorter answer once, never truncating or saving it", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;
    let attempts = 0;
    const provider = model(() => ({ prompt: attempts++ === 0 ? originalStart : shorter }));
    expect(await simplifyPrompt(scene, "startFramePrompt", provider)).toBe(shorter);
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(provider.generateJson).mock.calls[1]![1]).correction).toContain("fewer than");
  });

  it("fails explicitly if both attempts are longer", async () => {
    const record = await seeded();
    await expect(simplifyPrompt(record.storyboard!.scenes[0]!, "startFramePrompt", model(() => ({ prompt: originalStart })))).rejects.toThrow(/could not produce a shorter prompt/);
  });

  it("preserves spoken dialogue and gives a correction when it is dropped", async () => {
    const record = await seeded();
    const scene: Scene = { ...record.storyboard!.scenes[0]!, dialogue: [{ character: "Mara", line: "Come with me." }] };
    let calls = 0;
    const provider = model(() => ({ prompt: ++calls === 1 ? shorter : 'Mara opens the door and says, "Come with me." Then she enters the courtyard.' }));
    const result = await simplifyPrompt(scene, "videoPromptSegment", provider);
    expect(result).toContain("Come with me.");
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
  });

  it("instructs the model to preserve the requested scene and remove padding", () => {
    for (const clause of [
      "Krea 2", "who is where", "positive, concrete", "hand placement", "bound versus free",
      "attachment, separation", "number of people", "contradictions", "start state",
      "main movement", "end state", "who is chasing", "Do not add characters",
      "camera moves", "lens specs", "wardrobe", "only the simplified",
    ]) expect(SIMPLIFY_PROMPT_SYSTEM).toContain(clause);
  });
});

describe("bulk prompt API wiring", () => {
  it("supports adding, previewing and selectively applying through routes", async () => {
    const record = await seeded();
    const projectId = record.project.id;
    const props = { params: Promise.resolve({ projectId }) };
    const request = (body: unknown, method = "POST") => new Request("http://localhost/api/prompts", {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const added = await addRoute(request({ scope: "all", placement: "append", frames: "start", text: "A blue sign." }), props);
    expect(added.status).toBe(200);
    expect(added.headers.get("cache-control")).toBe("no-store");
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const preview = await previewRoute(request({ scope: "all", target: "image", frames: "start" }), props);
    expect(preview.status).toBe(200);
    const body = await preview.json() as { results: SimplifiedPrompt[] };
    const applied = await applyRoute(request({ results: [body.results[0]] }, "PATCH"), props);
    expect(applied.status).toBe(200);
    expect((await getProjectRecord(projectId)).storyboard!.scenes[0]!.prompts.startFramePrompt).toBe(shorter);
  });

  it("returns client errors for malformed JSON and empty selections", async () => {
    const record = await seeded();
    const props = { params: Promise.resolve({ projectId: record.project.id }) };
    for (const handler of [addRoute, previewRoute, applyRoute]) {
      expect((await handler(new Request("http://localhost", { method: "POST", body: "{" }), props)).status).toBe(400);
    }
    const res = await previewRoute(new Request("http://localhost", {
      method: "POST", body: JSON.stringify({ scope: "selected", sceneIds: [], target: "both" }),
    }), props);
    expect(res.status).toBe(400);
    expect(await repository.get(record.project.id)).toEqual(record);
  });
});
