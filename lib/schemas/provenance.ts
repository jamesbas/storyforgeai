import { z } from "zod";
import { maybe } from "@/lib/schemas/maybe";

/**
 * How an agent artifact was produced.
 *
 * Every agent falls back to a deterministic builder when the provider returns
 * nothing usable, and before this that fallback was invisible: the artifact
 * looked identical whether a model wrote it or a template did. See the ADR at
 * the end of SPEC-004 for why these fields and no others.
 */

export const EXECUTION_SOURCES = ["llm", "deterministic", "hybrid", "unknown"] as const;
export const executionSourceSchema = z.enum(EXECUTION_SOURCES);
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number];

export const EXECUTION_STATUSES = ["ok", "degraded", "failed", "legacy"] as const;
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * One closed taxonomy for provider, agents, metrics and UI.
 *
 * `provider_disabled` is not a failure: it is demo mode, and calling it one
 * would paint every deterministic run as degraded.
 */
export const FAILURE_REASONS = [
  "provider_disabled",
  "sdk_missing",
  "request_failed",
  "timeout",
  "empty_response",
  "unparseable_json",
  "schema_mismatch",
  "format_unsupported",
  "short_collection",
  "invalid_set",
  "unknown",
] as const;
export const failureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** What QC actually looked at, so a text-only verdict cannot read as a visual one. */
export const QC_EVIDENCE_MODES = ["deterministic", "text_only", "visual"] as const;
export const qcEvidenceModeSchema = z.enum(QC_EVIDENCE_MODES);
export type QcEvidenceMode = (typeof QC_EVIDENCE_MODES)[number];

export const artifactExecutionSchema = z.object({
  executionId: z.string(),
  /** Groups every execution produced by one user action. */
  correlationId: maybe(z.string()),
  /** Stable artifact key, e.g. `storyboard`, `scene-002.video_prompt`. */
  artifact: z.string(),
  /** `project` or a scene id, so scene work can be found without parsing keys. */
  scope: maybe(z.string()),
  source: executionSourceSchema,
  status: executionStatusSchema,
  provider: maybe(z.string()),
  model: maybe(z.string()),
  format: maybe(z.string()),
  promptVersion: maybe(z.string()),
  builderVersion: maybe(z.string()),
  fallbackReason: maybe(failureReasonSchema),
  /** Redacted and truncated free text. Never a prompt or a response body. */
  detail: maybe(z.string()),
  evidence: maybe(
    z.object({
      mode: qcEvidenceModeSchema,
      attachments: z.number().int().nonnegative(),
    }),
  ),
  /** For hybrid sets: how many parts came from the model. */
  attempted: maybe(
    z.object({
      total: z.number().int().nonnegative(),
      fromLlm: z.number().int().nonnegative(),
    }),
  ),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type ArtifactExecution = z.infer<typeof artifactExecutionSchema>;

/** Most records per artifact key, and per project. Oldest are dropped first. */
export const MAX_EXECUTIONS_PER_ARTIFACT = 5;
export const MAX_EXECUTIONS_PER_PROJECT = 200;

const SECRETISH = [
  /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
  /\b(?:sk|pk|api[_-]?key|bearer)[-_ :=]+[A-Za-z0-9._-]{8,}/gi,
  /https?:\/\/[^\s]+/gi,
];

/**
 * The one free-text field, so the one real leak risk.
 *
 * Strips data URLs, key-shaped tokens and URLs, then truncates. A provider
 * message can quote a request body, and an image agent's error can carry a
 * whole base64 frame.
 */
export function redactDetail(detail: string | undefined, limit = 200): string | undefined {
  if (!detail) return undefined;
  let safe = detail;
  for (const pattern of SECRETISH) safe = safe.replace(pattern, "[redacted]");
  safe = safe.replace(/\s+/g, " ").trim();
  if (!safe) return undefined;
  return safe.length <= limit ? safe : `${safe.slice(0, limit).trimEnd()}…`;
}

/** Append a record and enforce both bounds, oldest dropped first. */
export function appendExecution(
  existing: ArtifactExecution[] | undefined,
  next: ArtifactExecution,
): ArtifactExecution[] {
  const all = [...(existing ?? []), next];

  const perArtifact = new Map<string, number>();
  const keptReversed: ArtifactExecution[] = [];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const record = all[i]!;
    const seen = perArtifact.get(record.artifact) ?? 0;
    if (seen >= MAX_EXECUTIONS_PER_ARTIFACT) continue;
    perArtifact.set(record.artifact, seen + 1);
    keptReversed.push(record);
    if (keptReversed.length >= MAX_EXECUTIONS_PER_PROJECT) break;
  }
  return keptReversed.reverse();
}

/** The newest record for an artifact, which is what the UI shows. */
export function latestExecution(
  executions: ArtifactExecution[] | undefined,
  artifact: string,
): ArtifactExecution | undefined {
  if (!executions?.length) return undefined;
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    if (executions[i]!.artifact === artifact) return executions[i];
  }
  return undefined;
}
