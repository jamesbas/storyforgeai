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
  progress,
  onApply,
  onDiscard,
  onStop,
}: {
  preview: FixPreview;
  busy: boolean;
  /** Where this preview sits in a "Fix selected" run, if it is part of one. */
  progress?: { position: number; total: number };
  onApply: () => void;
  onDiscard: () => void;
  onStop?: () => void;
}) {
  const span = changedSpan(preview.before, preview.after);
  return (
    <div className="mt-2 rounded border border-sky-400/30 bg-sky-400/5 p-2" data-testid="scene-check-fix-preview">
      {progress ? (
        <p className="text-[10px] uppercase tracking-wide text-sky-300/80" data-testid="scene-check-fix-progress">
          Fix {progress.position} of {progress.total}
        </p>
      ) : null}
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
          {progress ? "Skip" : "Discard"}
        </button>
        {progress && onStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={busy}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-400 hover:border-white/25 disabled:opacity-50"
          >
            Stop
          </button>
        ) : null}
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
  status?: {
    quick: SceneCheckStatus;
    deep: SceneCheckStatus;
    /** Out of date only through fixes applied from that check; its other findings stay fixable. */
    fixesApplied?: { quick: boolean; deep: boolean };
  };
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
  const fixesApplied = Boolean(depth && current === "out_of_date" && status?.fixesApplied?.[depth]);
  /** Findings can be fixed: the check is current, or nothing but its own fixes has changed the scene. */
  const actionable = current !== "out_of_date" || fixesApplied;

  const [preview, setPreview] = useState<{ findingId: string; value: FixPreview } | null>(null);
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixErrors, setFixErrors] = useState<Record<string, string>>({});
  // Selection belongs to one result; a re-run reuses finding ids, so it is keyed by when it ran.
  const selectionKey = check && depth ? `${depth}:${check.checkedAt}` : "";
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const selected = selection.key === selectionKey ? selection.ids : [];
  /** A "Fix selected" run: the findings still to preview after the current one. */
  const [queue, setQueue] = useState<{ depth: SceneCheckDepth; remaining: string[]; total: number } | null>(null);

  const fixable = (finding: SceneFinding) =>
    !finding.fixed && finding.accepted?.inputHash !== check?.inputHash;

  const toggleSelected = (findingId: string) =>
    setSelection({
      key: selectionKey,
      ids: selected.includes(findingId) ? selected.filter((id) => id !== findingId) : [...selected, findingId],
    });

  /** Ask for a preview against the scene as it is now. False when none could be offered. */
  const requestFix = async (findingId: string, forDepth: SceneCheckDepth): Promise<boolean> => {
    setFixBusy(findingId);
    setFixErrors(({ [findingId]: _gone, ...rest }) => rest);
    setPreview(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scene-checks/${sceneId}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depth: forDepth, findingId }),
      });
      const body = (await res.json().catch(() => null)) as (FixPreview & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Could not propose a fix (HTTP ${res.status})`);
      setPreview({ findingId, value: body });
      return true;
    } catch (e) {
      setFixErrors((errors) => ({ ...errors, [findingId]: e instanceof Error ? e.message : "Could not propose a fix" }));
      return false;
    } finally {
      setFixBusy(null);
    }
  };

  /**
   * Preview the queued findings one at a time. Each is proposed only after the
   * one before it was applied or skipped, so every diff is against the text as
   * it now stands and two fixes to one prompt never collide.
   */
  const runQueue = async (forDepth: SceneCheckDepth, ids: string[], total: number) => {
    for (let i = 0; i < ids.length; i++) {
      setQueue({ depth: forDepth, remaining: ids.slice(i + 1), total });
      if (await requestFix(ids[i]!, forDepth)) return;
    }
    setQueue(null);
  };

  const continueQueue = () => {
    if (queue?.remaining.length) void runQueue(queue.depth, queue.remaining, queue.total);
    else setQueue(null);
  };

  const fixSelected = () => {
    if (!depth || !check) return;
    // In the order they are listed, not the order they were ticked.
    const ids = check.findings.filter((finding) => selected.includes(finding.id) && fixable(finding)).map((f) => f.id);
    if (!ids.length) return;
    setSelection({ key: selectionKey, ids: [] });
    void runQueue(depth, ids, ids.length);
  };

  const applyFix = async () => {
    if (!preview) return;
    setFixBusy(preview.findingId);
    try {
      const { kind, field, after, sourceHash, depth: fixDepth, findingId, summary } = preview.value;
      const res = await fetch(`/api/projects/${projectId}/scene-checks/${sceneId}/fix`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, field, after, sourceHash, depth: fixDepth, findingId, summary }),
      });
      const body = (await res.json().catch(() => null)) as (ProjectRecord & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Could not apply the fix (HTTP ${res.status})`);
      setPreview(null);
      onApplied(body);
      setFixBusy(null);
      continueQueue();
    } catch (e) {
      setFixErrors((errors) => ({
        ...errors,
        [preview.findingId]: e instanceof Error ? e.message : "Could not apply the fix",
      }));
      setFixBusy(null);
    }
  };

  const discardFix = () => {
    setPreview(null);
    continueQueue();
  };

  const stopQueue = () => {
    setPreview(null);
    setQueue(null);
  };

  const hasIssues = status?.quick === "issues" || status?.deep === "issues" ||
    Boolean(status?.fixesApplied?.quick || status?.fixesApplied?.deep) || Boolean(preview || queue);

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
                  disabled={Boolean(queue)}
                  className={`rounded px-2 py-1 disabled:opacity-50 ${depth === option ? "bg-white/10 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}
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
            {current === "out_of_date" && !fixesApplied ? (
              <p className="text-[11px] text-slate-300">
                The scene has changed since this check, so it no longer says anything about it. Run it again.
              </p>
            ) : null}
            {fixesApplied ? (
              <p className="text-[11px] text-sky-200/90" data-testid="scene-check-fixes-applied">
                {(() => {
                  const n = check.findings.filter((finding) => finding.fixed).length;
                  return `${n} ${n === 1 ? "fix has" : "fixes have"} been applied since this check, and nothing else has changed. `;
                })()}
                The other findings are still from the original review: each fix is proposed against the
                scene as it is now, but an earlier fix may already have resolved one. Run the check again
                when you are done to confirm — accepting a finding as intentional waits for that fresh check.
              </p>
            ) : null}
            {check.detail ? <p className="text-[11px] text-sky-200/80">{check.detail}</p> : null}
            {actionable && check.findings.filter(fixable).length > 1 ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={fixSelected}
                  disabled={!selected.length || busy || Boolean(running) || fixBusy !== null || Boolean(preview) || Boolean(queue)}
                  data-testid="scene-check-fix-selected"
                  className="rounded-md border border-white/15 px-2.5 py-1 hover:border-accent disabled:opacity-50"
                >
                  Fix selected{selected.length ? ` (${selected.length})` : ""}
                </button>
                <button
                  type="button"
                  onClick={() => setSelection({
                    key: selectionKey,
                    ids: selected.length ? [] : check.findings.filter(fixable).map((finding) => finding.id),
                  })}
                  disabled={Boolean(queue)}
                  className="text-slate-400 hover:text-slate-200 disabled:opacity-50"
                >
                  {selected.length ? "Clear selection" : "Select all"}
                </button>
                <span className="text-slate-500">Previews each in turn, against the text as the fix before it left it.</span>
              </div>
            ) : null}
            {check.findings.length === 0 ? (
              <p className="text-[11px] text-green-300/90">
                {check.coverage === "complete" ? "No problems found." : "Nothing found, but the review did not complete."}
              </p>
            ) : (
              <ul className="space-y-2">
                {check.findings.map((finding) => {
                  const accepted = finding.accepted?.inputHash === check.inputHash;
                  const canFix = actionable && fixable(finding);
                  return (
                    <li
                      key={finding.id}
                      className={`rounded border p-2 text-[11px] ${SEVERITY_STYLE[finding.severity]} ${accepted || finding.fixed ? "opacity-50" : ""}`}
                      data-testid="scene-check-finding"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {canFix ? (
                          <input
                            type="checkbox"
                            checked={selected.includes(finding.id)}
                            onChange={() => toggleSelected(finding.id)}
                            disabled={Boolean(queue)}
                            aria-label={`Select ${finding.code} to fix`}
                            data-testid="scene-check-select-finding"
                          />
                        ) : null}
                        <strong className="uppercase">{finding.severity}</strong>
                        <span>{FIELD_LABEL[finding.field]}</span>
                        <code className="text-slate-400">{finding.code}</code>
                        <span className="text-slate-500">
                          {finding.origin === "rule" ? "rule" : finding.origin === "vision" ? "seen in frame" : "review"}
                          {finding.certainty === "underspecified" ? " · underspecified" : ""}
                        </span>
                        {accepted ? <span className="text-slate-400">accepted as intentional</span> : null}
                        {finding.fixed ? (
                          <span className="text-green-300" data-testid="scene-check-finding-fixed">fix applied · re-check to confirm</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-slate-200">{finding.explanation}</p>
                      {finding.fixed?.summary ? (
                        <p className="mt-1 text-green-200/80"><span className="text-slate-500">Applied:</span> {finding.fixed.summary}</p>
                      ) : null}
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
                      {actionable && !finding.fixed ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {canFix ? (
                            <button
                              type="button"
                              onClick={() => depth && void requestFix(finding.id, depth)}
                              disabled={busy || Boolean(running) || fixBusy !== null || Boolean(queue)}
                              data-testid="scene-check-preview-fix"
                              className="rounded-md border border-white/15 px-2.5 py-1 hover:border-accent disabled:opacity-50"
                            >
                              {fixBusy === finding.id && !preview ? "Proposing…" : "Preview fix"}
                            </button>
                          ) : null}
                          {current !== "out_of_date" ? (
                            <button
                              type="button"
                              onClick={() => depth && onAccept(depth, finding.id, !accepted)}
                              disabled={busy || Boolean(running)}
                              className="rounded-md border border-white/10 px-2.5 py-1 text-slate-400 hover:border-white/25 disabled:opacity-50"
                            >
                              {accepted ? "Undo acceptance" : "Accept as intentional"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {fixErrors[finding.id] ? (
                        <p className="mt-1 text-red-300">{fixErrors[finding.id]}</p>
                      ) : null}
                      {preview?.findingId === finding.id ? (
                        <FixPreviewBox
                          preview={preview.value}
                          busy={fixBusy !== null}
                          progress={queue ? { position: queue.total - queue.remaining.length, total: queue.total } : undefined}
                          onApply={() => void applyFix()}
                          onDiscard={discardFix}
                          onStop={stopQueue}
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
