"use client";

import { useState } from "react";
import type { PlanField, PlanSpec } from "@/lib/agents/plan-fields";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

type NamedSpec = { name: string; description: string };

/** Values are held as text while editing, so a half-typed line is never invalid. */
type Draft = Record<string, string>;

const LINE = "\n";
/** Separates a map or named entry's key from its value, one entry per line. */
const SEP = ": ";

function toText(field: PlanField, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (field.kind) {
    case "text":
      return String(value);
    case "list":
      return Array.isArray(value) ? value.map(String).join(LINE) : "";
    case "map":
      return value && typeof value === "object"
        ? Object.entries(value as Record<string, string>)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([k, v]) => `${k}${SEP}${v}`)
            .join(LINE)
        : "";
    case "named":
      return Array.isArray(value)
        ? (value as NamedSpec[]).map((n) => `${n.name}${SEP}${n.description}`).join(LINE)
        : "";
  }
}

function fromText(field: PlanField, text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  switch (field.kind) {
    case "text":
      return text.trim();
    case "list":
      return lines;
    case "map":
      return Object.fromEntries(
        lines.map((line) => {
          const at = line.indexOf(SEP.trim());
          return at === -1
            ? [line, ""]
            : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
      );
    case "named":
      return lines.map((line) => {
        const at = line.indexOf(SEP.trim());
        return at === -1
          ? { name: line, description: "" }
          : { name: line.slice(0, at).trim(), description: line.slice(at + 1).trim() };
      });
  }
}

const PLACEHOLDER: Record<PlanField["kind"], string> = {
  text: "",
  list: "One per line",
  map: "1: what happens in segment 1",
  named: "Name: description",
};

/**
 * Read and edit what one agent produced.
 *
 * The plans steer every render but were visible only as a two-line summary on
 * the card, so a wrong premise or an unwanted shot plan could only be fixed by
 * regenerating and hoping. Lists and per-scene maps are edited as one entry per
 * line rather than as JSON: the shape cannot be broken by a stray comma, and
 * the server re-validates against the schema regardless.
 */
export function PlanPanel({
  spec,
  plan,
  projectId,
  disabled = false,
  onSaved,
}: {
  spec: PlanSpec;
  plan: Record<string, unknown>;
  projectId: string;
  disabled?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const original: Draft = Object.fromEntries(
    spec.fields.map((f) => [f.key, toText(f, plan[f.key])]),
  );
  const current = editing ? draft : original;
  const dirty = spec.fields.some((f) => current[f.key] !== original[f.key]);

  const startEditing = () => {
    setDraft(original);
    setError(null);
    setSaved(false);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = Object.fromEntries(
        spec.fields.map((f) => [f.key, fromText(f, draft[f.key] ?? "")]),
      );
      const res = await fetch(`/api/projects/${projectId}/plans/${spec.agentKey}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? "Failed to save");
      }
      const record = (await res.json()) as ProjectRecord;
      onSaved?.(record);
      setSaved(true);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="mt-3 rounded-md border border-white/10 bg-canvas/40 text-xs">
      <summary className="cursor-pointer px-3 py-2 text-slate-300">
        View {editing ? "and edit" : "or edit"} {spec.label}
      </summary>
      <div className="space-y-3 border-t border-white/10 p-3">
        {spec.fields.map((field) => {
          const text = current[field.key] ?? "";
          return (
            <div key={field.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400">{field.label}</span>
                {field.help ? (
                  <span className="text-[10px] text-slate-600">{field.help}</span>
                ) : null}
              </div>
              {editing ? (
                <textarea
                  value={text}
                  rows={field.rows ?? Math.min(8, Math.max(2, text.split(/\r?\n/).length + 1))}
                  placeholder={PLACEHOLDER[field.kind]}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [field.key]: e.target.value }))
                  }
                  className="mt-1 w-full rounded border border-white/10 bg-canvas px-2 py-1 font-mono text-[11px] leading-relaxed text-slate-200 outline-none focus:border-accent"
                />
              ) : text ? (
                <p className="mt-1 whitespace-pre-wrap text-slate-300">{text}</p>
              ) : (
                <p className="mt-1 text-slate-600">Not set</p>
              )}
            </div>
          );
        })}

        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="rounded bg-accent px-3 py-1 font-semibold text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                disabled={saving}
                className="rounded border border-white/15 px-3 py-1 text-slate-300"
              >
                Cancel
              </button>
              <span className="text-[10px] text-slate-600">
                Regenerate the storyboard afterwards, or the edit reaches nothing.
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={startEditing}
                disabled={disabled}
                className="rounded border border-white/15 px-3 py-1 text-slate-300 hover:border-accent disabled:opacity-50"
              >
                Edit
              </button>
              {saved && <span className="text-emerald-300">Saved</span>}
            </>
          )}
        </div>
      </div>
    </details>
  );
}
