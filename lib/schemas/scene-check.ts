import { z } from "zod";

/**
 * On-demand review of one scene: its card, prompts and — at the deep level —
 * its neighbours, its story beat and its rendered keyframes.
 *
 * Findings, never verdicts. Whether a scene "passed" is computed by the app
 * from the findings, their acceptance and whether the inputs have changed
 * since; a model is never asked to authorise anything.
 */

export const SCENE_CHECK_DEPTHS = ["quick", "deep"] as const;
export const sceneCheckDepthSchema = z.enum(SCENE_CHECK_DEPTHS);
export type SceneCheckDepth = z.infer<typeof sceneCheckDepthSchema>;

export const FINDING_CATEGORIES = [
  "identity",
  "story",
  "action",
  "continuity",
  "staging",
  "model_contract",
] as const;

export const FINDING_FIELDS = [
  "card",
  "startFramePrompt",
  "endFramePrompt",
  "endFrameEditPrompt",
  "videoPromptSegment",
  "startImage",
  "endImage",
] as const;
export const findingFieldSchema = z.enum(FINDING_FIELDS);
export type FindingField = z.infer<typeof findingFieldSchema>;

/** The prompt fields a fix may rewrite. */
export const FIXABLE_FIELDS = [
  "startFramePrompt",
  "endFramePrompt",
  "endFrameEditPrompt",
  "videoPromptSegment",
] as const satisfies readonly FindingField[];
export type FixableField = (typeof FIXABLE_FIELDS)[number];

export const findingSeveritySchema = z.enum(["info", "warning", "error"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const evidenceSchema = z.object({
  /** Where the excerpt is quoted from: a field, `card`, `people:<name>`, `storyBeat`, … */
  source: z.string().max(80),
  excerpt: z.string().max(400),
});

export const sceneFindingSchema = z.object({
  id: z.string(),
  code: z.string().max(60),
  category: z.enum(FINDING_CATEGORIES),
  severity: findingSeveritySchema,
  certainty: z.enum(["contradiction", "likely", "underspecified"]),
  /** `rule` is a deterministic check, `model` the text review, `vision` the frame review. */
  origin: z.enum(["rule", "model", "vision"]),
  field: findingFieldSchema,
  evidence: z.array(evidenceSchema).max(4).default([]),
  explanation: z.string().max(1200),
  suggestedFix: z.string().max(1200).optional(),
  /** Marked intentional. Bound to the inputs it was accepted against. */
  accepted: z.object({ at: z.string(), inputHash: z.string() }).optional(),
  /** A fix for it was applied after the check. Only a fresh check confirms it worked. */
  fixed: z.object({ at: z.string(), summary: z.string().max(400).optional() }).optional(),
});
export type SceneFinding = z.infer<typeof sceneFindingSchema>;

export const sceneCheckSchema = z.object({
  depth: sceneCheckDepthSchema,
  checkedAt: z.string(),
  /** Hash of exactly what the check read; a different current hash means out of date. */
  inputHash: z.string(),
  /**
   * The scene's inputs after the fixes applied from this check's findings.
   * While the scene still hashes to this, nothing but those fixes has touched
   * it, so the remaining findings can still be fixed — though the check itself
   * stays out of date until it is run again.
   */
  fixedInputHash: z.string().optional(),
  /** `text+vision` only when frames were actually sent to a vision model. */
  mode: z.enum(["text", "text+vision"]),
  /**
   * `failed` when the model call produced nothing usable — the rule findings
   * are still reported, but the scene is never shown as passed on them alone.
   */
  coverage: z.enum(["complete", "partial", "failed"]),
  findings: z.array(sceneFindingSchema),
  model: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  detail: z.string().max(500).optional(),
});
export type SceneCheck = z.infer<typeof sceneCheckSchema>;

export const sceneChecksSchema = z.record(
  z.object({
    quick: sceneCheckSchema.optional(),
    deep: sceneCheckSchema.optional(),
  }),
);
export type SceneChecks = z.infer<typeof sceneChecksSchema>;

export type SceneCheckStatus = "not_checked" | "passed" | "issues" | "incomplete" | "out_of_date";

/** Findings still asking for attention: warnings and errors nobody has accepted. */
export function openFindings(check: SceneCheck): SceneFinding[] {
  return check.findings.filter((finding) =>
    finding.severity !== "info" && finding.accepted?.inputHash !== check.inputHash);
}

/** The status a check earns, judged against the scene's current inputs. */
export function sceneCheckStatus(check: SceneCheck | undefined, currentHash: string): SceneCheckStatus {
  if (!check) return "not_checked";
  if (check.inputHash !== currentHash) return "out_of_date";
  if (openFindings(check).length) return "issues";
  if (check.coverage !== "complete") return "incomplete";
  return "passed";
}

/** Out of date only because fixes from its own findings were applied, so the rest can still be fixed. */
export function changedOnlyByFixes(check: SceneCheck | undefined, currentHash: string): boolean {
  return Boolean(check && check.inputHash !== currentHash && check.fixedInputHash === currentHash);
}

/** What the model returns: findings only, each citing where it read them. */
export const modelFindingSchema = z.object({
  code: z.string().max(60),
  category: z.enum(FINDING_CATEGORIES),
  severity: findingSeveritySchema,
  certainty: z.enum(["contradiction", "likely", "underspecified"]),
  field: findingFieldSchema,
  evidence: z.array(evidenceSchema).max(4),
  explanation: z.string().max(1200),
  suggestedFix: z.string().max(1200).optional(),
});
export type ModelFinding = z.infer<typeof modelFindingSchema>;

export const modelCheckSchema = z.object({
  findings: z.array(modelFindingSchema).max(15),
});

/** Request bodies. `thenRender` is "check first": render the scenes that pass. */
export const sceneCheckRunSchema = z.object({
  sceneIds: z.array(z.string().min(1)).min(1).max(200),
  depth: sceneCheckDepthSchema,
  thenRender: z.enum(["keyframes", "video"]).optional(),
});

export const sceneFindingAcceptSchema = z.object({
  depth: sceneCheckDepthSchema,
  findingId: z.string().min(1),
  accepted: z.boolean(),
});

export const sceneCheckFixPreviewSchema = z.object({
  depth: sceneCheckDepthSchema,
  findingId: z.string().min(1),
});

/**
 * Applying a previewed fix: the text and the hash of what it replaces, and —
 * optionally — the finding it was for, so that finding can be marked fixed.
 */
const fixedFindingRef = {
  depth: sceneCheckDepthSchema.optional(),
  findingId: z.string().min(1).optional(),
  summary: z.string().max(400).optional(),
};
export const sceneCheckFixApplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    sceneId: z.string().min(1),
    field: z.enum(FIXABLE_FIELDS),
    after: z.string().min(1).max(8000),
    sourceHash: z.string().min(1),
    ...fixedFindingRef,
  }),
  z.object({
    kind: z.literal("card"),
    sceneId: z.string().min(1),
    field: z.enum(["sceneObjective", "storyBeat", "visualDescription", "actionDescription", "cameraMovement"]),
    after: z.string().min(1).max(4000),
    sourceHash: z.string().min(1),
    ...fixedFindingRef,
  }),
]);
