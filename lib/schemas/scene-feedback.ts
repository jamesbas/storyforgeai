import { z } from "zod";

export const sceneFeedbackScopeSchema = z.enum(["keyframes", "start", "end", "video"]);
export type SceneFeedbackScope = z.infer<typeof sceneFeedbackScopeSchema>;

export const FEEDBACK_SCOPE_LABELS: Record<SceneFeedbackScope, string> = {
  keyframes: "Both keyframes",
  start: "Start keyframe only",
  end: "End keyframe only",
  video: "Video prompt only",
};

/** One prompt a feedback refinement may rewrite; several may be chosen at once. */
export const feedbackTargetSchema = z.enum(["start", "end", "video"]);
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;

export const FEEDBACK_TARGET_LABELS: Record<FeedbackTarget, string> = {
  start: "Start frame",
  end: "End frame",
  video: "Video",
};

/**
 * What a refinement may change. The per-scene panel picks one scope and lets a
 * keyframe fix pull the clip along; the multi-scene tool picks targets and
 * changes nothing it was not asked to.
 */
export type FeedbackPlan = {
  targets: readonly FeedbackTarget[];
  videoFollowsKeyframes: boolean;
};

export function scopePlan(scope: SceneFeedbackScope): FeedbackPlan {
  return {
    targets: scope === "keyframes" ? ["start", "end"] : [scope],
    videoFollowsKeyframes: scope !== "video",
  };
}

/** The prompt-agent passes, and for a single keyframe which one, that rewrite the ticked targets. */
export function rewriteOptionsFor(targets: readonly FeedbackTarget[]): {
  passes?: ("image" | "video")[];
  frames?: ("start" | "end")[];
} {
  const frames = (["start", "end"] as const).filter((frame) => targets.includes(frame));
  const video = targets.includes("video");
  // Everything ticked is the full rewrite, including its deferral of an unused clip prompt.
  if (frames.length === 2 && video) return {};
  return {
    passes: [...(frames.length ? ["image" as const] : []), ...(video ? ["video" as const] : [])],
    ...(frames.length === 1 ? { frames } : {}),
  };
}

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

const uniqueTargets = z.array(feedbackTargetSchema).min(1, "Pick at least one of start frame, end frame or video.")
  .max(3).refine((targets) => new Set(targets).size === targets.length, "Each target may be picked once.");

/** Applied directly, scene by scene: there is no preview step for the multi-scene tool. */
export const bulkFeedbackRequestSchema = z.object({
  sceneIds: z.array(z.string().min(1)).min(1, "Pick at least one scene.").max(500),
  targets: uniqueTargets,
  feedback: z.string().trim().min(1, "Describe what is wrong or what you want to see.").max(4000),
}).strict();

export type BulkFeedbackResult = {
  refined: { sceneId: string; sceneNumber: number; summary: string; warnings: string[] }[];
  failed: { sceneId: string; sceneNumber: number; error: string }[];
};

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
