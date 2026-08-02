"use client";

import type { ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * How an artifact was made, beside the artifact.
 *
 * Colour alone would not carry this — a deterministic plan and a degraded one
 * look identical to anyone who cannot see the difference between amber and
 * slate — so every state also spells itself out in words.
 */

const TONE: Record<string, string> = {
  llm: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  hybrid: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  deterministic: "border-white/10 bg-white/5 text-slate-300",
  unknown: "border-white/10 bg-white/5 text-slate-500",
};

const REASON_TEXT: Record<string, string> = {
  provider_disabled: "no planning model configured",
  sdk_missing: "the OpenAI SDK is not installed",
  request_failed: "the model could not be reached",
  timeout: "the model took too long",
  empty_response: "the model returned nothing",
  unparseable_json: "the model's answer was not valid JSON",
  schema_mismatch: "the model's answer had the wrong shape",
  format_unsupported: "the server rejected every response format",
  short_collection: "the model returned too few items",
  invalid_set: "the model's set broke its own rules",
  unknown: "the model returned nothing usable",
};

export function describeExecution(execution: ArtifactExecution | undefined): string {
  if (!execution) return "No provenance (legacy project)";
  if (execution.evidence && execution.evidence.mode !== "deterministic") {
    const frames = execution.evidence.attachments;
    return execution.evidence.mode === "visual"
      ? `Visual QC · ${frames} frame${frames === 1 ? "" : "s"}`
      : "Text-only QC";
  }
  if (execution.source === "hybrid" && execution.attempted) {
    return `Hybrid · ${execution.attempted.fromLlm}/${execution.attempted.total} from the model`;
  }
  if (execution.source === "llm") return `LLM${execution.model ? ` · ${execution.model}` : ""}`;
  if (execution.source === "unknown") return "Unknown source";
  return "Deterministic";
}

export function ExecutionBadge({
  execution,
  className = "",
}: {
  execution: ArtifactExecution | undefined;
  className?: string;
}) {
  const tone = TONE[execution?.source ?? "unknown"] ?? TONE.unknown;
  const degraded = execution?.status === "degraded";
  const reason = degraded ? REASON_TEXT[execution.fallbackReason ?? "unknown"] : undefined;

  return (
    <span
      data-testid="execution-badge"
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${tone} ${className}`}
      title={
        execution
          ? `${describeExecution(execution)}${reason ? ` — ${reason}` : ""}` +
            (execution.correlationId ? ` (run ${execution.correlationId.slice(0, 8)})` : "")
          : "This project predates provenance"
      }
    >
      {describeExecution(execution)}
      {reason ? <span className="text-amber-200/80">· {reason}</span> : null}
    </span>
  );
}
