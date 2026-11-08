"use client";

import { useState } from "react";
import type { FixPreview } from "@/lib/services/scene-check-service";
import type {
  FindingField,
  SceneCheck,
  SceneCheckDepth,
  SceneCheckStatus,
  SceneFinding,
} from "@/lib/schemas/scene-check";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

export const STATUS_LABEL: Record<SceneCheckStatus, string> = {
  not_checked: "Not checked",
  passed: "Passed",
  issues: "Issues",
  incomplete: "Incomplete",
  out_of_date: "Out of date",
};

const STATUS_STYLE: Record<SceneCheckStatus, string> = {
  not_checked: "border-white/10 text-slate-500",
  passed: "border-green-500/40 text-green-300",
  issues: "border-amber-400/50 text-amber-200",
  incomplete: "border-sky-400/40 text-sky-200",
  out_of_date: "border-slate-400/40 text-slate-300",
};

const FIELD_LABEL: Record<FindingField, string> = {
  card: "Scene card",
  startFramePrompt: "Start frame",
  endFramePrompt: "End frame",
  endFrameEditPrompt: "End-frame edit",
  videoPromptSegment: "Clip",
  startImage: "Rendered start frame",
  endImage: "Rendered end frame",
};

const SEVERITY_STYLE: Record<SceneFinding["severity"], string> = {
  error: "bg-red-500/15 text-red-200 border-red-500/40",
  warning: "bg-amber-400/10 text-amber-200 border-amber-400/40",
  info: "bg-white/5 text-slate-300 border-white/15",
};

export function SceneCheckBadge({ depth, status }: { depth: SceneCheckDepth; status: SceneCheckStatus }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[status]}`}
      data-testid={`scene-check-badge-${depth}`}
    >
      {depth === "quick" ? "Quick" : "Deep"}: {STATUS_LABEL[status]}
    </span>
  );
}

/** The changed middle of two strings, so a one-word fix is visible in a long prompt. */
function changedSpan(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start && end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;
  return {
    prefix: before.slice(Math.max(0, start - 80), start),
    removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end),
    suffix: before.slice(before.length - end, before.length - end + 80),
  };
}

function FixPreviewBox({
  preview,
  busy,
  onApply,
  onDiscard,
}: {
  preview: FixPreview;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const span = changedSpan(preview.before, preview.after);
  return (
    <div className="mt-2 rounded border border-sky-400/30 bg-sky-400/5 p-2" data-testid="scene-check-fix-preview">
      <p className="text-[11px] text-sky-200">
        {preview.summary} <span className="text-slate-500">({preview.kind === "card" ? `card: ${preview.field}` : FIELD_LABEL[preview.field]})</span>
      </p>
      <p className="mt-1 break-words font-mono text-[11px] text-slate-300">
        …{span.prefix}
        {span.removed ? <del className="bg-red-500/20 text-red-200">{span.removed}</del> : null}
        {span.added ? <ins className="bg-green-500/20 text-green-200 no-underline">{span.added}</ins> : null}
        {span.suffix}…
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] hover:border-accent disabled:opacity-50"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-400 hover:border-white/25 disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * One scene's checks: run them, read the findings, accept or fix each one.
 *
 * Nothing here runs on its own. A check is a model call on the same GPU as
 * the renders, so it happens when someone presses the button and not before.
 */
export function SceneCheckPanel({
  projectId,
  sceneId,
  checks,
  status,
  running,
  busy,
  onRun,
  onAccept,
  onApplied,
}: {
  projectId: string;
  sceneId: string;
  checks?: { quick?: SceneCheck; deep?: SceneCheck };
  status?: { quick: SceneCheckStatus; deep: SceneCheckStatus };
  /** This scene's place in a running batch, if it has one. */
  running?: { depth: SceneCheckDepth; state: "pending" | "running" };
  busy?: boolean;
  onRun: (depth: SceneCheckDepth) => void;
  onAccept: (depth: SceneCheckDepth, findingId: string, accepted: boolean) => void;
  onApplied: (record: ProjectRecord) => void;
}) {
  const latest = (["quick", "deep"] as const)
    .filter((depth) => checks?.[depth])
    .sort((a, b) => checks![b]!.checkedAt.localeCompare(checks![a]!.checkedAt))[0];
  const [shown, setShown] = useState<SceneCheckDepth | undefined>(undefined);
  const depth = shown && checks?.[shown] ? shown : latest;
  const check = depth ? checks?.[depth] : undefined;
  const current = depth && status ? status[depth] : undefined;

  const [preview, setPreview] = useState<{ findingId: string; value: FixPreview } | null>(null);
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixError, setFixError] = useState<{ findingId: string; message: string } | null>(null);

  const requestFix = async (finding: SceneFinding) => {
    if (!depth) return;
    setFixBusy(finding.id);
    setFixError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scene-checks/${sceneId}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depth, findingId: finding.id }),
      });
      const body = (await res.json().catch(() => null)) as (FixPreview & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Could not propose a fix (HTTP ${res.status})`);
      setPreview({ findingId: finding.id, value: body });
    } catch (e) {
      setFixError({ findingId: finding.id, message: e instanceof Error ? e.message : "Could not propose a fix" });
    } finally {
      setFixBusy(null);
    }
  };

  const applyFix = async () => {
    if (!preview) return;
    setFixBusy(preview.findingId);
    try {
      const { kind, field, after, sourceHash } = preview.value;
      const res = await fetch(`/api/projects/${projectId}/scene-checks/${sceneId}/fix`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, field, after, sourceHash }),
      });
      const body = (await res.json().catch(() => null)) as (ProjectRecord & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Could not apply the fix (HTTP ${res.status})`);
      setPreview(null);
      onApplied(body);
    } catch (e) {
      setFixError({ findingId: preview.findingId, message: e instanceof Error ? e.message : "Could not apply the fix" });
    } finally {
      setFixBusy(null);
    }
  };

  const hasIssues = status?.quick === "issues" || status?.deep === "issues";

  return (
    <details className="mt-3 rounded-md border border-white/10 bg-black/20" open={hasIssues || undefined} data-testid="scene-check-panel">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs text-slate-300">
        <span>Scene check</span>
        {status ? (
          <>
            <SceneCheckBadge depth="quick" status={status.quick} />
            <SceneCheckBadge depth="deep" status={status.deep} />
          </>
        ) : null}
        {running ? (
          <span className="text-[10px] text-sky-300">
            {running.state === "running" ? `Checking (${running.depth})…` : `Queued (${running.depth})`}
          </span>
        ) : null}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-[11px] text-slate-500">
          <strong>Quick</strong> reviews this scene&apos;s prompts against its card and the people in
          it, text only. <strong>Deep</strong> also checks the card against the story beat, the
          scenes either side, the staging, and — with a vision model — the rendered keyframes.
          Each is one model call on the GPU the renders use.
        </p>
        <div className="flex flex-wrap gap-2">
          {(["quick", "deep"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onRun(option)}
              disabled={busy || Boolean(running)}
              data-testid={`scene-check-run-${option}`}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
            >
              {option === "quick" ? "Quick check" : "Deep check"}
            </button>
          ))}
          {checks?.quick && checks?.deep ? (
            <span className="ml-auto flex gap-1 text-[11px]">
              {(["quick", "deep"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setShown(option)}
                  className={`rounded px-2 py-1 ${depth === option ? "bg-white/10 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}
                >
                  {option === "quick" ? "Quick result" : "Deep result"}
                </button>
              ))}
            </span>
          ) : null}
        </div>

        {check && depth ? (
          <div className="space-y-2" data-testid="scene-check-result">
            <p className="text-[11px] text-slate-500">
              {depth === "quick" ? "Quick" : "Deep"} check, {new Date(check.checkedAt).toLocaleString()} ·{" "}
              {check.mode === "text+vision" ? "prompts and rendered frames" : "prompts only"}
              {check.model ? ` · ${check.model}` : ""}
              {check.coverage !== "complete" ? ` · ${check.coverage}` : ""}
            </p>
            {current === "out_of_date" ? (
              <p className="text-[11px] text-slate-300">
                The scene has changed since this check, so it no longer says anything about it. Run it again.
              </p>
            ) : null}
            {check.detail ? <p className="text-[11px] text-sky-200/80">{check.detail}</p> : null}
            {check.findings.length === 0 ? (
              <p className="text-[11px] text-green-300/90">
                {check.coverage === "complete" ? "No problems found." : "Nothing found, but the review did not complete."}
              </p>
            ) : (
              <ul className="space-y-2">
                {check.findings.map((finding) => {
                  const accepted = finding.accepted?.inputHash === check.inputHash;
                  return (
                    <li
                      key={finding.id}
                      className={`rounded border p-2 text-[11px] ${SEVERITY_STYLE[finding.severity]} ${accepted ? "opacity-50" : ""}`}
                      data-testid="scene-check-finding"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="uppercase">{finding.severity}</strong>
                        <span>{FIELD_LABEL[finding.field]}</span>
                        <code className="text-slate-400">{finding.code}</code>
                        <span className="text-slate-500">
                          {finding.origin === "rule" ? "rule" : finding.origin === "vision" ? "seen in frame" : "review"}
                          {finding.certainty === "underspecified" ? " · underspecified" : ""}
                        </span>
                        {accepted ? <span className="text-slate-400">accepted as intentional</span> : null}
                      </div>
                      <p className="mt-1 text-slate-200">{finding.explanation}</p>
                      {finding.evidence.length ? (
                        <ul className="mt-1 space-y-0.5 text-slate-400">
                          {finding.evidence.map((item) => (
                            <li key={`${item.source}:${item.excerpt}`}>
                              <span className="text-slate-500">{item.source}:</span> &ldquo;{item.excerpt}&rdquo;
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {finding.suggestedFix ? (
                        <p className="mt-1 text-slate-300"><span className="text-slate-500">Suggested:</span> {finding.suggestedFix}</p>
                      ) : null}
                      {current !== "out_of_date" ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {!accepted ? (
                            <button
                              type="button"
                              onClick={() => void requestFix(finding)}
                              disabled={busy || fixBusy !== null}
                              data-testid="scene-check-preview-fix"
                              className="rounded-md border border-white/15 px-2.5 py-1 hover:border-accent disabled:opacity-50"
                            >
                              {fixBusy === finding.id && !preview ? "Proposing…" : "Preview fix"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => depth && onAccept(depth, finding.id, !accepted)}
                            disabled={busy || Boolean(running)}
                            className="rounded-md border border-white/10 px-2.5 py-1 text-slate-400 hover:border-white/25 disabled:opacity-50"
                          >
                            {accepted ? "Undo acceptance" : "Accept as intentional"}
                          </button>
                        </div>
                      ) : null}
                      {fixError?.findingId === finding.id ? (
                        <p className="mt-1 text-red-300">{fixError.message}</p>
                      ) : null}
                      {preview?.findingId === finding.id ? (
                        <FixPreviewBox
                          preview={preview.value}
                          busy={fixBusy !== null}
                          onApply={() => void applyFix()}
                          onDiscard={() => setPreview(null)}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}
