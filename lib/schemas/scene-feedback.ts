import { z } from "zod";

export const sceneFeedbackScopeSchema = z.enum(["keyframes", "start", "end", "video"]);
export type SceneFeedbackScope = z.infer<typeof sceneFeedbackScopeSchema>;

export const FEEDBACK_SCOPE_LABELS: Record<SceneFeedbackScope, string> = {
  keyframes: "Both keyframes",
  start: "Start keyframe only",
  end: "End keyframe only",
  video: "Video prompt only",
};

export const FEEDBACK_FIELDS = [
  "startFramePrompt",
  "endFramePrompt",
  "endFrameEditPrompt",
  "videoPromptSegment",
  "videoSoundscape",
  "videoScore",
] as const;
export type FeedbackField = (typeof FEEDBACK_FIELDS)[number];

export const FEEDBACK_FIELD_LABELS: Record<FeedbackField, string> = {
  startFramePrompt: "Start keyframe",
  endFramePrompt: "End keyframe",
  endFrameEditPrompt: "End-frame edit",
  videoPromptSegment: "Video motion",
  videoSoundscape: "Video soundscape",
  videoScore: "Video score",
};

export const sceneFeedbackRequestSchema = z.object({
  scope: sceneFeedbackScopeSchema,
  feedback: z.string().trim().min(1, "Describe what is wrong or what you want to see.").max(4000),
}).strict();

export const sceneFeedbackProposalSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  revisions: z.array(z.object({
    field: z.enum(FEEDBACK_FIELDS),
    after: z.string().trim().max(8000),
    reason: z.string().trim().min(1).max(600),
  }).strict()).min(1).max(FEEDBACK_FIELDS.length),
  videoReview: z.object({
    needsChange: z.boolean(),
    explanation: z.string().trim().min(1).max(1000),
  }).strict(),
}).strict();
export type SceneFeedbackProposal = z.infer<typeof sceneFeedbackProposalSchema>;

export const sceneFeedbackApplySchema = z.object({
  scope: sceneFeedbackScopeSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposal: sceneFeedbackProposalSchema,
}).strict();

export type SceneFeedbackChange = {
  sceneId: string;
  sceneNumber: number;
  field: FeedbackField;
  before: string;
  after: string;
  reason: string;
  carried?: boolean;
};

export type SceneFeedbackPreview = {
  sceneId: string;
  scope: SceneFeedbackScope;
  sourceHash: string;
  proposal: SceneFeedbackProposal;
  changes: SceneFeedbackChange[];
  warnings: string[];
};
