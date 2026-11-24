import { createHash } from "node:crypto";
import { changesDialogue, isSkip, proposeSceneDialogue } from "@/lib/agents/dialogue-sync";
import { repository } from "@/lib/db/store";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import {
  dialogueSyncApplySchema,
  dialogueSyncPreviewRequestSchema,
  type DialogueSyncApplyResult,
  type DialogueSyncPreview,
} from "@/lib/schemas/dialogue-sync";
import type { Scene } from "@/lib/schemas/storyboard";
import { withCardEdits } from "@/lib/services/card-feedback-service";
import { resolveProjectCast } from "@/lib/services/character-service";
import { appendHistory, getProjectRecord } from "@/lib/services/project-service";
import { logEvent } from "@/lib/telemetry";

/**
 * Exactly what a dialogue sync reads from a scene, and nothing else.
 *
 * Narrow on purpose: renders write to the project record continuously, and a
 * preview made stale by an unrelated clip finishing would be refused for no
 * reason. A change to this scene's dialogue or video prompt is a real reason.
 */
function sceneHash(scene: Scene): string {
  return createHash("sha256")
    .update(JSON.stringify({ dialogue: scene.dialogue ?? [], prompt: scene.prompts?.videoPromptSegment ?? "" }))
    .digest("hex");
}

/**
 * What syncing would change, scene by scene. Nothing is saved.
 *
 * No model is involved: the lines are read from the prompt and matched to the
 * card deterministically, so the preview is the save.
 */
export async function previewDialogueSync(projectId: string, raw: unknown): Promise<DialogueSyncPreview> {
  const request = dialogueSyncPreviewRequestSchema.parse(raw ?? {});
  const record = await getProjectRecord(projectId);
  const all = record.storyboard?.scenes;
  if (!all?.length) throw new ValidationError("Generate a storyboard before syncing dialogue.");
  const missing = request.sceneIds?.find((id) => !all.some((scene) => scene.id === id));
  if (missing) throw new NotFoundError(`Scene ${missing} not found`);

  const cast = (await resolveProjectCast(record.project)).map((character) => character.name);
  const picked = request.sceneIds ? new Set(request.sceneIds) : undefined;
  const scenes = all.filter((scene) => !picked || picked.has(scene.id))
    .sort((a, b) => a.sceneNumber - b.sceneNumber);

  const preview: DialogueSyncPreview = { scenes: [], unchanged: 0, skipped: [] };
  for (const scene of scenes) {
    const result = proposeSceneDialogue(scene, cast);
    if (isSkip(result)) preview.skipped.push(result);
    else if (!changesDialogue(result)) preview.unchanged += 1;
    else preview.scenes.push({ ...result, sceneHash: sceneHash(scene) });
  }
  logEvent("dialogue_sync.previewed", {
    projectId,
    requested: scenes.length,
    changed: preview.scenes.length,
    unchanged: preview.unchanged,
    skipped: preview.skipped.length,
  });
  return preview;
}

/**
 * Save the dialogue the person approved, replacing each scene card's dialogue.
 *
 * Prompts are left exactly as they are — they are the source being copied —
 * while the cast in the shot is recomputed and the prompt warnings refreshed
 * against the new card, as for any hand edit of a card. Every scene is checked
 * before any is saved, so a refusal leaves the project untouched.
 */
export async function applyDialogueSync(projectId: string, raw: unknown): Promise<DialogueSyncApplyResult> {
  const body = dialogueSyncApplySchema.parse(raw);
  if (new Set(body.scenes.map((s) => s.sceneId)).size !== body.scenes.length) {
    throw new ValidationError("Each scene may appear once.");
  }
  // The cast is looked up first so the record is read as late as possible: the
  // read-to-write window is where a render finishing could be overwritten.
  const cast = await resolveProjectCast((await getProjectRecord(projectId)).project);
  const record = await getProjectRecord(projectId);
  const scenes = record.storyboard?.scenes;
  if (!scenes) throw new ValidationError("Generate a storyboard before syncing dialogue.");

  for (const entry of body.scenes) {
    const scene = scenes.find((s) => s.id === entry.sceneId);
    if (!scene) throw new NotFoundError(`Scene ${entry.sceneId} not found`);
    if (sceneHash(scene) !== entry.sceneHash) {
      throw new PrerequisiteError(
        `Scene ${scene.sceneNumber}'s dialogue or video prompt changed after this preview. ` +
          "Preview again before applying; nothing was saved.",
      );
    }
  }

  const edits = body.scenes.map((entry) => ({
    sceneId: entry.sceneId,
    card: { dialogue: entry.dialogue.map((line) => ({ character: line.character.trim(), line: line.line.trim() })) },
    wardrobe: null,
  }));
  const numbers = body.scenes
    .map((entry) => scenes.find((s) => s.id === entry.sceneId)!.sceneNumber)
    .sort((a, b) => a - b);
  let updated = withCardEdits(record, cast, edits);
  updated = {
    ...updated,
    project: { ...updated.project, updatedAt: new Date().toISOString() },
    history: appendHistory(updated, "scene.card_edited", `Dialogue from video prompt — Scene ${numbers.join(", ")}`),
  };
  await repository.update(projectId, updated);
  logEvent("dialogue_sync.applied", { projectId, scenes: body.scenes.map((s) => s.sceneId) });
  return { record: updated, updated: numbers };
}
