import { z } from "zod";
import { dialogueLineSchema } from "@/lib/schemas/audio";
import { maybe } from "@/lib/schemas/maybe";
import { feedbackTargetSchema } from "@/lib/schemas/scene-feedback";
import { dialogueModeSchema, sceneCardPatchSchema, type ProjectRecord } from "@/lib/schemas/storyboard";
import { sceneWardrobeChangesSchema } from "@/lib/schemas/wardrobe";
import type { DialogueMode } from "@/lib/types";

export const CARD_TEXT_FIELDS = [
  "title",
  "sceneObjective",
  "storyBeat",
  "visualDescription",
  "actionDescription",
  "cameraMovement",
] as const;
export type CardTextField = (typeof CARD_TEXT_FIELDS)[number];

export const CARD_CHANGE_LABELS: Record<CardTextField | "frameVisibility" | "dialogue" | "dialogueMode" | "wardrobe", string> = {
  title: "Title",
  sceneObjective: "Objective",
  storyBeat: "Story beat",
  visualDescription: "Visual description",
  actionDescription: "Action",
  cameraMovement: "Camera movement",
  frameVisibility: "Who is visible",
  dialogue: "Dialogue",
  dialogueMode: "Dialogue mode",
  wardrobe: "Wardrobe change at this scene",
};

/** How a dialogue mode reads in the UI. */
export const DIALOGUE_MODE_LABELS: Record<DialogueMode, string> = {
  full: "Full (most of the clip)",
  brief: "Brief (a short line)",
  silent: "Silent (no dialogue)",
};

export const cardFeedbackRequestSchema = z.object({
  sceneIds: z.array(z.string().min(1)).min(1, "Pick at least one scene.").max(500),
  feedback: z.string().trim().min(1, "Describe what is wrong or what you want to see.").max(4000),
}).strict();

/**
 * What the model returns for one card.
 *
 * Every part is required, with an explicit `changed` flag, so a structured
 * output server never has to decide between omitting a key and sending null.
 */
export const cardFeedbackProposalSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  revisions: z.array(z.object({
    field: z.enum(CARD_TEXT_FIELDS),
    after: z.string().trim().min(1).max(4000),
    reason: z.string().trim().min(1).max(600),
  }).strict()).max(CARD_TEXT_FIELDS.length),
  frameVisibility: z.object({
    changed: z.boolean(),
    start: z.array(z.string().trim().min(1)).max(30),
    end: z.array(z.string().trim().min(1)).max(30),
  }).strict(),
  dialogue: z.object({
    changed: z.boolean(),
    lines: z.array(dialogueLineSchema).max(24),
    /** Set when the feedback changes how much the scene is spoken, e.g. "make it silent". */
    mode: maybe(dialogueModeSchema),
  }).strict(),
  wardrobe: z.object({
    changed: z.boolean(),
    changes: z.array(z.object({
      who: z.string().trim().min(1).max(120),
      wardrobe: z.string().trim().min(1).max(400),
      mode: z.enum(["within", "between"]),
    }).strict()).max(8),
  }).strict(),
}).strict();
export type CardFeedbackProposal = z.infer<typeof cardFeedbackProposalSchema>;

/** One scene's corrections, in the form they are saved. Null means unchanged. */
export const cardEditSchema = z.object({
  sceneId: z.string().min(1),
  card: sceneCardPatchSchema.nullable(),
  wardrobe: sceneWardrobeChangesSchema.nullable(),
}).strict();
export type CardEdit = z.infer<typeof cardEditSchema>;

export type CardChangeField = keyof typeof CARD_CHANGE_LABELS;

export type CardFeedbackPreview = {
  sourceHash: string;
  scenes: {
    sceneId: string;
    sceneNumber: number;
    summary: string;
    edit: CardEdit;
    changes: { field: CardChangeField; before: string; after: string; reason?: string }[];
  }[];
  failed: { sceneId: string; sceneNumber: number; error: string }[];
  warnings: string[];
};

export const cardFeedbackApplySchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(feedbackTargetSchema).min(1).max(3)
    .refine((targets) => new Set(targets).size === targets.length, "Each target may be picked once."),
  edits: z.array(cardEditSchema).min(1).max(500),
}).strict();

export type CardFeedbackApplyResult = {
  record: ProjectRecord;
  promptsRewritten: boolean;
  promptError?: string;
};
