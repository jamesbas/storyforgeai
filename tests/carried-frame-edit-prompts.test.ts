import { beforeEach, describe, expect, it } from "vitest";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { buildCreativeBrief, buildSceneDrafts, buildStoryPlan, buildVisualBible } from "@/lib/agents/mock-agents";
import { config } from "@/lib/config";
import { parseFiboPrompt } from "@/lib/agents/fibo-prompt";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import {
  createProject, generateStoryboard, getProjectRecord, regenerateScenesPrompts,
  updateProjectModels, updateSceneFraming, updateScenePrompts,
} from "@/lib/services/project-service";
import { generateProjectMediaPhased, generateSceneMedia, previewSceneRenders } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { addImagePromptText } from "@/lib/services/prompt-tools-service";
import { buildCarriedFrameEditPrompt } from "@/lib/agents/model-directives";
import { simplifyPrompt } from "@/lib/agents/prompt-simplifier";
import { repository } from "@/lib/db/store";
import { seamBreak } from "@/lib/media/seam";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

const opening = "Medium shot, eye level, front. Mara sits at a wooden table in a quiet room, her right hand around a ceramic cup. Exactly one woman is in frame.";
const closing = "Medium shot, eye level, front. Mara sits at a wooden table in a quiet room, the ceramic cup resting on the table beside her right hand. Exactly one woman is in frame.";
const edit = "Edit the supplied reference frame: put Mara's ceramic cup on the wooden table beside her right hand. Mara remains seated in the quiet room. Keep the medium shot, eye level, front angle, her face, hair, wardrobe and the room's lighting unchanged. Exactly one woman is in frame. Use additional photographs only for Mara's identity.";

class RecordingClient extends MockWangpClient {
  readonly calls: { prompt: string; refs: string[] }[] = [];
  async generate(settings: Record<string, unknown>) {
    this.calls.push({
      prompt: String(settings.prompt ?? ""),
      refs: Array.isArray(settings.image_refs) ? settings.image_refs.filter((ref): ref is string => typeof ref === "string") : [],
    });
    return super.generate(settings);
  }
}

let client: RecordingClient;
beforeEach(() => {
  client = new RecordingClient();
  setWangpClient(client);
});

async function project(endFrameReferences?: boolean, requestedDurationSeconds = 60) {
  const p = await createProject({
    concept: "Mara puts her ceramic cup on a wooden table in a quiet room.",
    requestedDurationSeconds,
    sceneContinuity: "reuse_end_frame",
    generationMode: "keyframes_only",
  });
  return endFrameReferences === undefined ? p :
    (await updateProjectModels(p.id, { endFrameReferences })).project;
}

async function authored(endFrameReferences?: boolean, options: {
  seam?: boolean;
  override?: boolean;
  imageModel?: string;
  cardShots?: readonly string[];
  responseShots?: readonly string[];
  omitEdit?: boolean;
} = {}) {
  const p = await project(endFrameReferences, options.cardShots ? options.cardShots.length * 20 : 60);
  if (options.imageModel) p.imageModel = options.imageModel;
  const bible = { ...buildVisualBible(p), characters: [{ name: "Mara", description: "A woman with brown hair." }] };
  const drafts = buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), bible).map((scene, index) => ({
    ...scene,
    visualDescription: `${options.cardShots?.[index] ? `${options.cardShots[index]}, eye level. ` : ""}Mara sits at a wooden table in a quiet room.`,
    actionDescription: "Mara puts her ceramic cup on the wooden table.",
    cameraMovement: "Fixed camera",
    transitionIn: "Continuous",
    transitionOut: "Continuous",
  }));
  if (options.seam) drafts[1]!.transitionIn = "Hard cut";
  if (options.override) p.sceneEndFrameRefs = { [drafts[1]!.id]: false };
  const calls: { system: string; user: Record<string, unknown> }[] = [];
  const provider: PlanningProvider = {
    name: "test",
    generateJson: async (system, user, schema) => {
      const data = JSON.parse(user.split("\nPrevious answer to rewrite:\n")[0]!) as Record<string, unknown>;
      calls.push({ system, user: data });
      if (system.startsWith("Convert two approved")) return null;
      if (!data.scene || typeof data.scene !== "object" ||
          !("sceneNumber" in data.scene) || typeof data.scene.sceneNumber !== "number") {
        throw new Error("The image request must identify its scene.");
      }
      const shot = options.responseShots?.[data.scene.sceneNumber - 1] ?? "Medium shot";
      return schema.parse({
        startFramePrompt: opening.replace("Medium shot", shot),
        endFramePrompt: closing.replace("Medium shot", shot),
        imageNegativePrompt: "watermark",
        ...(data.carriedFrame && !options.omitEdit
          ? { endFrameEditPrompt: edit.replace("medium shot", shot.toLowerCase()) } : {}),
      });
    },
  };
  const executions: ArtifactExecution[] = [];
  const scenes = await attachScenePrompts(p, drafts, provider, {
    visualBible: bible, onExecution: (execution) => executions.push(execution),
  });
  return { p, scenes, calls, drafts, bible, provider, executions };
}

describe("authoring carried-frame edits", () => {
  it("authors edits despite different framing on every scene card, and renders them with the source", async () => {
    const { p, scenes, calls, executions, drafts, bible } = await authored(true, {
      cardShots: ["Wide shot", "Medium shot", "Medium close-up", "Close-up", "Medium wide shot", "Medium close-up", "Extreme close-up"],
      responseShots: ["Medium shot", "Medium wide shot", "Medium close-up", "Medium wide shot", "Medium shot", "Medium wide shot", "Medium wide shot"],
    });
    expect(scenes).toHaveLength(7);
    expect(scenes[0]!.prompts.endFrameEditPrompt).toBeUndefined();
    expect(seamBreak(drafts[0]!, drafts[1]!)).not.toBeNull();
    for (let i = 1; i < scenes.length; i++) {
      const previous = scenes[i - 1]!;
      const scene = scenes[i]!;
      expect(scene.prompts.startFramePrompt).toBe(previous.prompts.endFramePrompt);
      expect(scene.prompts.endFrameEditPrompt).toMatch(/^Edit the supplied reference frame/);
      expect(seamBreak(previous, scene, { clipCarriesArrivals: false })).toBeNull();
      const call = calls.find((call) =>
        call.user.scene && typeof call.user.scene === "object" &&
        "sceneNumber" in call.user.scene && call.user.scene.sceneNumber === scene.sceneNumber,
      );
      expect(call?.user.carriedFrame).toEqual({
        shows: previous.prompts.endFramePrompt,
        instruction: "This is the source image to edit into the scene's closing frame.",
      });
      expect(call?.system).toContain("a self-contained image-edit instruction");
      expect(executions.find((execution) => execution.artifact === `${scene.id}.image_prompt`)).toMatchObject({
        source: "llm", promptVersion: "image-prompt-v8", detail: "end_frame=carried_frame_edit",
      });
    }
    const record = await generateStoryboard(p.id);
    await repository.update(p.id, {
      ...record, project: p, storyboard: { ...record.storyboard!, visualBible: bible, scenes },
    });
    await generateProjectMediaPhased(p.id, scenes.map((scene) => scene.id));
    const after = await getProjectRecord(p.id);
    for (let i = 1; i < scenes.length; i++) {
      const scene = scenes[i]!;
      const previous = after.attempts![scenes[i - 1]!.id]![0]!;
      const attempt = after.attempts![scene.id]![0]!;
      expect(attempt.startImagePath).toBe(previous.endImagePath);
      expect(client.calls.some((call) =>
        call.prompt.startsWith(scene.prompts.endFrameEditPrompt!) && call.refs.includes(previous.endImagePath!),
      )).toBe(true);
    }
  });

  it("keeps the carried opening when a model omits the edit and the repair path runs", async () => {
    const { scenes, executions } = await authored(true, {
      cardShots: ["Wide shot", "Close-up", "Extreme close-up"], omitEdit: true,
    });
    expect(scenes[1]!.prompts.startFramePrompt).toBe(scenes[0]!.prompts.endFramePrompt);
    expect(scenes[1]!.prompts.endFrameEditPrompt).toMatch(/^Edit the supplied reference frame/);
    expect(executions.find((execution) => execution.artifact === `${scenes[1]!.id}.image_prompt`)).toMatchObject({
      source: "hybrid", fallbackReason: "invalid_set",
    });
  });

  it("copies a kept predecessor's completed frame during a selective rewrite", async () => {
    const { p, drafts, bible, provider, scenes } = await authored(true, {
      cardShots: ["Wide shot", "Close-up", "Extreme close-up"],
    });
    const previous = { ...scenes[0]!.prompts, endFramePrompt: closing.replace("Medium shot", "Wide shot") };
    const existing = Object.fromEntries(scenes.map((scene) => [scene.id, scene.prompts]));
    existing[scenes[0]!.id] = previous;
    const rewritten = await attachScenePrompts(p, drafts, provider, {
      visualBible: bible, only: new Set([scenes[1]!.id]), existing, passes: ["image"],
    });
    expect(rewritten[0]!.prompts).toEqual(previous);
    expect(rewritten[1]!.prompts.startFramePrompt).toBe(previous.endFramePrompt);
    expect(rewritten[1]!.prompts.endFrameEditPrompt).toBeDefined();
    expect(rewritten[2]!.prompts).toEqual(scenes[2]!.prompts);
  });

  it("does not trim or re-normalise an inherited opening to fit this scene's word budget", async () => {
    const { p, drafts, bible, provider, scenes } = await authored(true);
    const source = `${closing}${" The established room remains unchanged.".repeat(100)}`;
    const existing = Object.fromEntries(scenes.map((scene) => [scene.id, scene.prompts]));
    existing[scenes[0]!.id] = { ...scenes[0]!.prompts, endFramePrompt: source };
    const executions: ArtifactExecution[] = [];
    const rewritten = await attachScenePrompts(p, drafts, provider, {
      visualBible: bible, only: new Set([scenes[1]!.id]), existing, passes: ["image"],
      onExecution: (execution) => executions.push(execution),
    });
    expect(rewritten[1]!.prompts.startFramePrompt).toBe(source);
    expect(executions.find((execution) => execution.artifact === `${scenes[1]!.id}.image_prompt`)).toMatchObject({
      source: "llm", detail: "end_frame=carried_frame_edit",
    });
  });

  it.each([false, true])("respects the no-clip safeguard for a newly arriving person (clip %s)", async (hasClip) => {
    const { p, drafts, bible, scenes } = await authored(true);
    p.generationMode = hasClip ? "video_segments" : "keyframes_only";
    const target = drafts[1]!;
    target.visualDescription = "Mara sits at the wooden table in a quiet room. Noah is outside the room.";
    target.actionDescription = "Noah enters the room and sits beside Mara at the wooden table.";
    const destination = "Medium shot, eye level, front. Noah sits beside Mara at the wooden table in the quiet room. Mara's cup rests on the table. Exactly two people are in frame: one woman and one man.";
    const provider: PlanningProvider = {
      name: "arrival-test",
      generateJson: async (_system, user, schema) => {
        const input = JSON.parse(user.split("\nPrevious answer to rewrite:\n")[0]!);
        return schema.parse({
          startFramePrompt: opening, endFramePrompt: destination, imageNegativePrompt: "watermark",
          ...(input.carriedFrame ? { endFrameEditPrompt: `Edit the supplied reference frame: seat Noah beside Mara at the wooden table. ${destination}` } : {}),
        });
      },
    };
    const rewritten = await attachScenePrompts(p, drafts, provider, {
      visualBible: { ...bible, characters: [...bible.characters, { name: "Noah", description: "A man with black hair." }] },
      only: new Set([target.id]), existing: Object.fromEntries(scenes.map((scene) => [scene.id, scene.prompts])),
      passes: ["image"],
    });
    expect(rewritten[1]!.prompts.startFramePrompt).toBe(scenes[0]!.prompts.endFramePrompt);
    expect(Boolean(rewritten[1]!.prompts.endFrameEditPrompt)).toBe(hasClip);
  });

  it("does not modify a carried opening in the deterministic path", async () => {
    const { p, drafts, bible } = await authored(true, {
      cardShots: ["Wide shot", "Close-up", "Extreme close-up"],
    });
    const scenes = await attachScenePrompts(p, drafts, null, { visualBible: bible });
    expect(scenes[1]!.prompts.startFramePrompt).toBe(scenes[0]!.prompts.endFramePrompt);
    expect(scenes[1]!.prompts.endFrameEditPrompt).toBeDefined();
  });

  it.each([true, undefined])("authors an edit only for eligible later frames (setting %s)", async (setting) => {
    const { scenes, calls } = await authored(setting);
    expect(scenes[0]!.prompts.endFrameEditPrompt).toBeUndefined();
    expect(scenes[1]!.prompts.endFrameEditPrompt).toBe(edit);
    expect(scenes[1]!.prompts.endFramePrompt).toContain("ceramic cup resting on the table");
    expect(calls[0]!.user.carriedFrame).toBeUndefined();
    const later = calls.find((call) => call.user.carriedFrame);
    expect(later?.system).toContain("a self-contained image-edit instruction");
    expect(later?.system).toContain("not extra people");
    expect(later?.user.carriedFrame).toEqual({
      shows: scenes[0]!.prompts.endFramePrompt,
      instruction: "This is the source image to edit into the scene's closing frame.",
    });
  });

  it("does not author edits with Prompt and face swap only", async () => {
    const { scenes, calls } = await authored(false);
    expect(scenes.every((scene) => scene.prompts.endFrameEditPrompt === undefined)).toBe(true);
    expect(calls.every((call) => !call.system.includes("a self-contained image-edit instruction"))).toBe(true);
    expect(scenes[1]!.prompts.startFramePrompt).not.toBe(scenes[0]!.prompts.endFramePrompt);
  });

  it.each([{ seam: true }, { override: true }])("skips a scene with no reference (%j)", async (options) => {
    const { scenes } = await authored(true, options);
    expect(scenes[1]!.prompts.endFrameEditPrompt).toBeUndefined();
  });

  it("respects the global reference switch", async () => {
    const previous = config.media.endFrameReferencesStartFrame;
    Object.defineProperty(config.media, "endFrameReferencesStartFrame", { value: false });
    try {
      const { scenes } = await authored(true);
      expect(scenes.every((scene) => !scene.prompts.endFrameEditPrompt)).toBe(true);
    } finally {
      Object.defineProperty(config.media, "endFrameReferencesStartFrame", { value: previous });
    }
  });

  it("keeps the deterministic fallback edit-focused", async () => {
    const { p, drafts, bible } = await authored(true);
    const scenes = await attachScenePrompts(p, drafts, null, { visualBible: bible });
    expect(scenes[0]!.prompts.endFrameEditPrompt).toBeUndefined();
    expect(scenes[1]!.prompts.endFrameEditPrompt).toMatch(/^Edit the supplied reference frame/);
  });

  it("preserves a directed wardrobe change rather than insisting on identical clothing", () => {
    const prompt = buildCarriedFrameEditPrompt(closing, true);
    expect(prompt).toContain("action and clothing come from this scene's own description");
    expect(prompt).not.toContain("identical clothing");
  });

  it("stores valid Fibo edits and standalone creation captions", async () => {
    const { scenes } = await authored(true, { imageModel: "fibo" });
    const prompt = scenes[1]!.prompts.endFrameEditPrompt;
    expect(prompt).toBeDefined();
    expect(parseFiboPrompt(prompt!)?.edit_instruction).toBe(edit);
    expect(parseFiboPrompt(scenes[1]!.prompts.endFramePrompt)?.edit_instruction).toBeUndefined();
    expect(scenes[1]!.prompts.startFramePrompt).toBe(scenes[0]!.prompts.endFramePrompt);
  });
});

async function renderable() {
  const p = await project(true);
  const record = await generateStoryboard(p.id);
  const ids = record.storyboard!.scenes.map((scene) => scene.id);
  await updateScenePrompts(p.id, ids[1]!, { endFrameEditPrompt: edit, endFramePrompt: closing });
  return { p, ids };
}

describe("sending edits only with the carried image", () => {
  it("uses the edit on the phased path and preview", async () => {
    const { p, ids } = await renderable();
    const preview = await previewSceneRenders(p.id);
    const destination = preview.find((frame) => frame.sceneId === ids[1] && frame.purpose === "end_frame");
    expect(String(destination?.settings?.prompt)).toContain(edit);
    await generateProjectMediaPhased(p.id, ids);
    const call = client.calls.find((call) => call.prompt.startsWith(edit));
    expect(call).toBeDefined();
    const record = await getProjectRecord(p.id);
    expect(call?.refs).toContain(record.attempts?.[ids[0]!]![0]!.endImagePath);
  });

  it("uses the same edit on the scene-at-a-time path", async () => {
    const { p, ids } = await renderable();
    await generateSceneMedia(p.id, ids[0]!);
    client.calls.length = 0;
    await generateSceneMedia(p.id, ids[1]!);
    expect(client.calls.find((call) => call.prompt.startsWith(edit))?.refs).toHaveLength(1);
  });

  it.each(["project", "scene", "missing predecessor", "cut"] as const)("uses creation instead with %s", async (reason) => {
    const { p, ids } = await renderable();
    if (reason !== "missing predecessor") await generateSceneMedia(p.id, ids[0]!);
    if (reason === "project") await updateProjectModels(p.id, { endFrameReferences: false });
    if (reason === "scene") await updateSceneFraming(p.id, ids[1]!, { endFrameReference: false });
    if (reason === "cut") await updateProjectModels(p.id, { sceneContinuity: "cut" });
    client.calls.length = 0;
    await generateSceneMedia(p.id, ids[1]!);
    expect(client.calls.some((call) => call.prompt.startsWith(edit))).toBe(false);
    expect(client.calls.find((call) => call.prompt.startsWith(closing))?.refs).toHaveLength(0);
  });

  it("keeps a hand edit during a video-only rewrite", async () => {
    const { p, ids } = await renderable();
    const after = await regenerateScenesPrompts(p.id, [ids[1]!], { passes: ["video"] });
    expect(after.storyboard!.scenes[1]!.prompts.endFrameEditPrompt).toBe(edit);
  });

  it("clears a stale edit when the creation destination is changed by hand", async () => {
    const { p, ids } = await renderable();
    const after = await updateScenePrompts(p.id, ids[1]!, { endFramePrompt: `${closing} A blue book on the table.` });
    expect(after.storyboard!.scenes[1]!.prompts.endFrameEditPrompt).toBeUndefined();
  });

  it("does not accept a simplification that turns an edit into a creation prompt", async () => {
    const { p, ids } = await renderable();
    const record = await getProjectRecord(p.id);
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async (_system, _user, schema) => schema.parse({ prompt: "Mara sits at the table." }),
    };
    await expect(simplifyPrompt(
      record.storyboard!.scenes.find((scene) => scene.id === ids[1])!,
      "endFrameEditPrompt", provider,
    )).rejects.toThrow(/could not produce/);
  });

  it("rejects malformed Fibo JSON in the editable edit field", async () => {
    const { p, ids } = await renderable();
    await expect(updateScenePrompts(p.id, ids[1]!, {
      endFrameEditPrompt: '{"structured_caption": {}}',
    })).rejects.toThrow(/Invalid Fibo VGL JSON/);
  });

  it("bulk end-frame additions also update the edit that is actually rendered", async () => {
    const { p, ids } = await renderable();
    const after = await addImagePromptText(p.id, {
      scope: "selected", sceneIds: [ids[1]!], frames: "end", placement: "append", text: "A blue book on the table.",
    });
    expect(after.storyboard!.scenes[1]!.prompts.endFrameEditPrompt).toBe(`${edit}\nA blue book on the table.`);
  });
});
