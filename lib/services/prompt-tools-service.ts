import { createHash } from "node:crypto";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { isShorterPrompt, simplifyPrompt } from "@/lib/agents/prompt-simplifier";
import { config } from "@/lib/config";
import { repository } from "@/lib/db/store";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import {
  addPromptTextSchema,
  applySimplifiedPromptsSchema,
  imagePromptFields,
  simplifyPromptsSchema,
  type PromptPreview,
} from "@/lib/schemas/prompt-tools";
import { scenePromptsPatchSchema, type ProjectRecord, type Scene } from "@/lib/schemas/storyboard";
import { getAgentRun, trackAgentRun } from "@/lib/services/agent-runs";
import { appendHistory, getProjectRecord } from "@/lib/services/project-service";
import { getQueue } from "@/lib/services/scene-queue";
import { activeTask } from "@/lib/tasks/task-service";
import { logEvent } from "@/lib/telemetry";
import { fiboTextPreserved, mapFiboDescription } from "@/lib/agents/fibo-prompt";

async function assertIdle(projectId: string): Promise<void> {
  if (getAgentRun(projectId) || getQueue(projectId).active ||
      (config.flags.durableTasks && await activeTask(projectId))) {
    throw new PrerequisiteError("Wait for the current generation or planning run to finish before using bulk prompt tools.");
  }
}

function selectedScenes(
  record: ProjectRecord,
  input: { scope: "all" | "selected"; sceneIds: string[] },
): Scene[] {
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before editing prompts.");
  const wanted = new Set(input.sceneIds);
  if (input.scope === "selected") {
    for (const id of wanted) {
      if (!record.storyboard.scenes.some((scene) => scene.id === id)) {
        throw new NotFoundError(`Scene ${id} not found`);
      }
    }
  }
  const scenes = record.storyboard.scenes.filter(
    (scene) => input.scope === "all" || wanted.has(scene.id),
  );
  if (!scenes.length) throw new ValidationError("Pick at least one scene.");
  return scenes;
}

function sourceHash(scene: Scene): string {
  return createHash("sha256").update(JSON.stringify(scene)).digest("hex");
}

async function savePrompts(
  record: ProjectRecord,
  patches: Map<string, Partial<Scene["prompts"]>>,
  change: string,
): Promise<ProjectRecord> {
  let historyRecord = record;
  for (const scene of record.storyboard!.scenes) {
    if (patches.has(scene.id)) {
      historyRecord = {
        ...historyRecord,
        history: appendHistory(historyRecord, "scene.prompts_edited", `Scene ${scene.sceneNumber}`),
      };
    }
  }
  const updated: ProjectRecord = {
    ...record,
    history: historyRecord.history,
    project: { ...record.project, updatedAt: new Date().toISOString() },
    storyboard: {
      ...record.storyboard!,
      scenes: record.storyboard!.scenes.map((scene) => patches.has(scene.id)
        ? { ...scene, prompts: { ...scene.prompts, ...patches.get(scene.id) } }
        : scene),
    },
  };
  await repository.update(record.project.id, updated);
  logEvent("project.updated", { id: record.project.id, change, sceneIds: [...patches.keys()] });
  return updated;
}

export async function addImagePromptText(projectId: string, raw: unknown): Promise<ProjectRecord> {
  const input = addPromptTextSchema.parse(raw);
  await assertIdle(projectId);
  const record = await getProjectRecord(projectId);
  const scenes = selectedScenes(record, input);
  const patches = new Map<string, Partial<Scene["prompts"]>>();
  for (const scene of scenes) {
    const patch: Partial<Scene["prompts"]> = {};
    for (const field of imagePromptFields(input.frames)) {
      const current = scene.prompts[field];
      patch[field] = mapFiboDescription(current, (description) => (input.placement === "prepend"
        ? [input.text, description]
        : [description, input.text]).filter((text) => text.length > 0).join("\n"));
    }
    patches.set(scene.id, scenePromptsPatchSchema.parse(patch));
  }
  return savePrompts(record, patches, "image_prompt_text_added");
}

export async function previewSimplifiedPrompts(projectId: string, raw: unknown): Promise<PromptPreview> {
  const input = simplifyPromptsSchema.parse(raw);
  await assertIdle(projectId);
  const record = await getProjectRecord(projectId);
  const scenes = selectedScenes(record, input);
  const provider = getPlanningProvider();
  if (!provider) {
    throw new PrerequisiteError("Prompt simplification requires AI planning and a configured planning model. Configure the LLM connection first.");
  }
  return trackAgentRun(projectId, "prompt_simplifier", "Prompt Simplifier", async () => {
    const results: PromptPreview["results"] = [];
    const fields = input.target === "video" ? [] : imagePromptFields(input.frames);
    if (input.target !== "image") fields.push("videoPromptSegment");
    for (const scene of scenes) {
      for (const field of fields) {
        const base = {
          sceneId: scene.id,
          sceneNumber: scene.sceneNumber,
          field,
          before: scene.prompts[field],
          sourceHash: sourceHash(scene),
        };
        try {
          results.push({ ...base, status: "ready", after: await simplifyPrompt(scene, field, provider) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Prompt simplification failed.";
          results.push({ ...base, status: "error", error: message });
          logEvent("agent.llm.failed", { projectId, agent: "prompt_simplifier", sceneId: scene.id, field });
        }
      }
    }
    return { results };
  });
}

export async function applySimplifiedPrompts(projectId: string, raw: unknown): Promise<ProjectRecord> {
  const { results } = applySimplifiedPromptsSchema.parse(raw);
  await assertIdle(projectId);
  const record = await getProjectRecord(projectId);
  if (!record.storyboard) throw new ValidationError("Generate a storyboard before editing prompts.");
  const patches = new Map<string, Partial<Scene["prompts"]>>();
  for (const result of results) {
    const scene = record.storyboard.scenes.find((s) => s.id === result.sceneId);
    if (!scene) throw new NotFoundError(`Scene ${result.sceneId} not found`);
    if (sourceHash(scene) !== result.sourceHash || scene.prompts[result.field] !== result.before) {
      throw new PrerequisiteError(`Scene ${scene.sceneNumber} changed since this preview. Preview again before applying; nothing was saved.`);
    }
    if (!isShorterPrompt(result.before, result.after)) {
      throw new ValidationError("Each simplified prompt must be shorter than its original.");
    }
    if (result.field !== "videoPromptSegment" && !fiboTextPreserved(result.before, result.after)) {
      throw new ValidationError("Fibo simplification must keep valid VGL, its objects and exact lettering.");
    }
    const patch = patches.get(scene.id) ?? {};
    if (patch[result.field] !== undefined) throw new ValidationError("A prompt was selected more than once.");
    patch[result.field] = result.after;
    patches.set(scene.id, scenePromptsPatchSchema.parse(patch));
  }
  return savePrompts(record, patches, "prompts_simplified");
}
