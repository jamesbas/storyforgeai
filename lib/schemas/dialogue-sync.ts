import { z } from "zod";
import { dialogueLineSchema } from "@/lib/schemas/audio";
import type { DialogueSyncProposal, DialogueSyncSkip } from "@/lib/agents/dialogue-sync";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/** Preview one scene, several, or the whole storyboard when none are named. */
export const dialogueSyncPreviewRequestSchema = z.object({
  sceneIds: z.array(z.string().min(1)).max(500).optional(),
}).strict();

export type DialogueSyncScenePreview = DialogueSyncProposal & {
  /** What the proposal was read from; the save is refused if it has changed. */
  sceneHash: string;
};

export type DialogueSyncPreview = {
  scenes: DialogueSyncScenePreview[];
  /** Scenes whose card already says what the prompt says. */
  unchanged: number;
  skipped: DialogueSyncSkip[];
};

/**
 * The dialogue to save for each scene, as the person left it in the preview —
 * speakers chosen, lines dropped. Saved as sent once each scene is checked to
 * be the one previewed.
 */
export const dialogueSyncApplySchema = z.object({
  scenes: z.array(z.object({
    sceneId: z.string().min(1),
    sceneHash: z.string().min(1),
    dialogue: z.array(dialogueLineSchema.extend({
      character: z.string().trim().min(1, "Every line needs a speaker."),
      line: z.string().trim().min(1, "A line cannot be empty."),
    })).max(24),
  }).strict()).min(1).max(500),
}).strict();
export type DialogueSyncApply = z.infer<typeof dialogueSyncApplySchema>;

export type DialogueSyncApplyResult = { record: ProjectRecord; updated: number[] };
