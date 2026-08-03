import { randomUUID } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import {
  redactDetail,
  type ArtifactExecution,
  type ExecutionSource,
  type ExecutionStatus,
  type FailureReason,
  type QcEvidenceMode,
} from "@/lib/schemas/provenance";
import type { GenerateOptions, PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";

/**
 * Provenance for one artifact, recorded by the wrapper rather than by each
 * agent, so a fallback path cannot forget to report itself.
 */

export type ExecutionCollector = (execution: ArtifactExecution) => void;

export type ExecuteOptions<T> = {
  /** Stable artifact key, e.g. `storyboard` or `scene-002.image_prompt`. */
  artifact: string;
  /** `project`, or the scene id for scene-scoped work. */
  scope?: string;
  correlationId?: string;
  promptVersion?: string;
  builderVersion?: string;
  provider: PlanningProvider | null;
  /** The model call. Omitted when an agent has no LLM path. */
  llm?: () => Promise<ProviderResult<T>>;
  /** Always available; this is what makes every agent degrade rather than fail. */
  fallback: () => T | Promise<T>;
  /**
   * Lets an agent reject a structurally valid answer, e.g. a storyboard batch
   * that came back short. Returning a reason sends it to the fallback.
   */
  validate?: (value: T) => FailureReason | undefined;
  onExecution?: ExecutionCollector;
  evidence?: { mode: QcEvidenceMode; attachments: number };
  attempted?: { total: number; fromLlm: number };
  /** Force the recorded source, for sets that were partly repaired. */
  source?: ExecutionSource;
  /**
   * Provenance that is only knowable once the model has answered, such as how
   * much of a repaired set survived. Applied when the model produced a usable
   * value, so a caller never has to rewrite the record afterwards.
   */
  outcome?: (value: T) => {
    source?: ExecutionSource;
    fallbackReason?: FailureReason;
    detail?: string;
    attempted?: { total: number; fromLlm: number };
  };
};

export type ExecutionResult<T> = {
  value: T;
  execution: ArtifactExecution;
};

function statusFor(source: ExecutionSource, reason: FailureReason | undefined): ExecutionStatus {
  if (source === "llm") return "ok";
  // Demo mode is not a degraded run: nobody asked for a model.
  if (!reason || reason === "provider_disabled") return "ok";
  return "degraded";
}

/**
 * Run an artifact's LLM path with its deterministic builder behind it, and
 * record how it actually went.
 *
 * Agents used to do `const r = await provider.generateJson(...); if (r) return r;
 * return build(...)`, which is why a local model silently producing nothing
 * looked exactly like demo mode.
 */
export async function executeArtifact<T>(options: ExecuteOptions<T>): Promise<ExecutionResult<T>> {
  const startedAt = new Date();
  const { artifact, scope, correlationId, provider, llm, fallback, validate, onExecution } = options;

  let source: ExecutionSource = options.source ?? "deterministic";
  let reason: FailureReason | undefined;
  let detail: string | undefined;
  let model: string | undefined;
  let format: string | undefined;
  let value: T | undefined;
  let attempted = options.attempted;

  if (!provider || !llm) {
    reason = "provider_disabled";
  } else {
    try {
      const result = await llm();
      model = result.model;
      format = result.format;
      if (!result.ok) {
        reason = result.reason;
        detail = result.detail;
      } else {
        const rejected = validate?.(result.value);
        if (rejected) reason = rejected;
        else {
          value = result.value;
          source = options.source ?? "llm";
          const outcome = options.outcome?.(result.value);
          if (outcome) {
            source = outcome.source ?? source;
            reason = outcome.fallbackReason ?? reason;
            detail = outcome.detail ?? detail;
            attempted = outcome.attempted ?? attempted;
          }
        }
      }
    } catch (err) {
      reason = "request_failed";
      detail = err instanceof Error ? err.message : String(err);
    }
  }

  if (value === undefined) {
    value = await fallback();
    if (source === "llm") source = "deterministic";
  }

  const finishedAt = new Date();
  const execution: ArtifactExecution = {
    executionId: randomUUID(),
    correlationId,
    artifact,
    scope,
    source,
    status: statusFor(source, reason),
    provider: provider ? provider.name : undefined,
    model,
    format,
    promptVersion: options.promptVersion,
    builderVersion: options.builderVersion,
    fallbackReason: reason,
    detail: redactDetail(detail),
    evidence: options.evidence,
    attempted,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };

  onExecution?.(execution);
  return { value, execution };
}

/**
 * One provider call as an envelope.
 *
 * Uses the richer `generate` when the provider offers it, so the real failure
 * reason survives; a test fake implementing only `generateJson` still produces
 * provenance, with reason `unknown`.
 */
export function providerCall<T>(
  provider: PlanningProvider,
  system: string,
  user: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  options?: GenerateOptions,
): () => Promise<ProviderResult<T>> {
  return async () => {
    if (provider.generate) return provider.generate(system, user, schema, options);
    const value = await provider.generateJson(system, user, schema, options);
    return value === null || value === undefined
      ? { ok: false, reason: "unknown", provider: provider.name }
      : { ok: true, value, provider: provider.name };
  };
}

/**
 * A record assembled by the caller, for artifacts built from several calls.
 *
 * The storyboard is written in batches and can end up part model, part builder,
 * which no single-call wrapper can describe.
 */
export function composeExecution(options: {
  artifact: string;
  scope?: string;
  correlationId?: string;
  promptVersion?: string;
  builderVersion?: string;
  provider?: string;
  model?: string;
  format?: string;
  source: ExecutionSource;
  fallbackReason?: FailureReason;
  detail?: string;
  attempted?: { total: number; fromLlm: number };
  evidence?: { mode: QcEvidenceMode; attachments: number };
  startedAt: Date;
}): ArtifactExecution {
  const finishedAt = new Date();
  return {
    executionId: randomUUID(),
    correlationId: options.correlationId,
    artifact: options.artifact,
    scope: options.scope,
    source: options.source,
    status: statusFor(options.source, options.fallbackReason),
    provider: options.provider,
    model: options.model,
    format: options.format,
    promptVersion: options.promptVersion,
    builderVersion: options.builderVersion,
    fallbackReason: options.fallbackReason,
    detail: redactDetail(options.detail),
    evidence: options.evidence,
    attempted: options.attempted,
    startedAt: options.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - options.startedAt.getTime()),
  };
}

/** A record for work that never had an LLM path, e.g. a pure QC file check. */
export function deterministicExecution(options: {
  artifact: string;
  scope?: string;
  correlationId?: string;
  builderVersion?: string;
  composerVersion?: string;
  lint?: string[];
  evidence?: { mode: QcEvidenceMode; attachments: number };
  startedAt?: Date;
}): ArtifactExecution {
  const startedAt = options.startedAt ?? new Date();
  const finishedAt = new Date();
  return {
    executionId: randomUUID(),
    correlationId: options.correlationId,
    artifact: options.artifact,
    scope: options.scope,
    source: "deterministic",
    status: "ok",
    provider: undefined,
    model: undefined,
    format: undefined,
    promptVersion: undefined,
    builderVersion: options.builderVersion,
    composerVersion: options.composerVersion,
    lint: options.lint,
    fallbackReason: "provider_disabled",
    detail: undefined,
    evidence: options.evidence,
    attempted: undefined,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}
