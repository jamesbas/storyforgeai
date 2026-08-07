"use client";

import { useState } from "react";
import type { Scene } from "@/lib/schemas/storyboard";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ArtifactExecution } from "@/lib/schemas/provenance";
import { ExecutionBadge } from "@/components/shared/execution-badge";
import { dedupeSentences, hasPunctuationArtifact } from "@/lib/agents/media-prompt-spec";
import { missingDialogue, opensWithFraming, echoesInstructions } from "@/lib/agents/media-prompt-normalise";

/** The prompt fields a user may edit. The quality checklist is agent review notes. */
const FIELDS = [
  { key: "startFramePrompt", label: "Start frame", rows: 4, kind: "image" },
  { key: "endFramePrompt", label: "End frame", rows: 4, kind: "image" },
  { key: "imageNegativePrompt", label: "Image negative", rows: 2, kind: "image" },
  { key: "videoPromptSegment", label: "Video (motion)", rows: 5, kind: "video" },
  { key: "videoNegativePrompt", label: "Video negative", rows: 2, kind: "video" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Draft = Record<FieldKey, string>;

/**
 * Local lint on the text as edited, so a problem is visible before a job is
 * submitted rather than after a render comes back wrong.
 *
 * Composed from the same validators the composer uses, so the panel cannot
 * disagree with what generation will do. Every item is a warning: these are
 * quality problems a human may knowingly accept, and blocking an edit on one
 * would make the field unusable for deliberate experiments.
 */
function lintField(key: FieldKey, text: string, scene: Scene): string[] {
  const notes: string[] = [];
  if (key.toLowerCase().includes("negative")) return notes;

  if (!text.trim()) return ["Empty — generation will fall back to whatever the model invents."];
  if (dedupeSentences(text) !== text) notes.push("A sentence is repeated; the model weights it twice.");
  if (hasPunctuationArtifact(text)) notes.push("Punctuation artifact, usually from concatenation.");

  for (const echo of echoesInstructions(text)) {
    notes.push(`"${echo}" narrates the brief rather than the scene; the model renders those words.`);
  }

  if (key === "startFramePrompt" || key === "endFramePrompt") {
    if (!opensWithFraming(text)) {
      notes.push("Does not open with shot size and camera height; the model will choose its own.");
    }
  }

  if (key === "videoPromptSegment" && scene.dialogue?.length) {
    const dropped = missingDialogue(text, scene.dialogue);
    if (dropped.length) {
      notes.push(`Dialogue missing from the prompt, so it will not be spoken: ${dropped.join(" / ")}`);
    }
  }

  return notes;
}

function draftFrom(scene: Scene): Draft {
  return {
    startFramePrompt: scene.prompts.startFramePrompt,
    endFramePrompt: scene.prompts.endFramePrompt,
    imageNegativePrompt: scene.prompts.imageNegativePrompt,
    videoPromptSegment: scene.prompts.videoPromptSegment,
    videoNegativePrompt: scene.prompts.videoNegativePrompt,
  };
}

/**
 * The prompts actually sent to WanGP, editable in place.
 *
 * Agent-written prompts are a strong starting point rather than a final answer,
 * and regenerating the whole storyboard to fix one clumsy line loses every other
 * scene's wording. Editing here changes only this scene.
 */
export function ScenePromptsPanel({
  scene,
  projectId,
  triggerWords,
  videoFamily,
  busy = false,
  execution,
  onSaved,
}: {
  scene: Scene;
  projectId: string;
  /** Trigger words that will be appended automatically, by prompt kind. */
  triggerWords?: { image: string[]; video: string[] };
  /** Pinned video family, so the panel can say what generation will add. */
  videoFamily?: string;
  busy?: boolean;
  /** SPEC-004 record for this scene's prompt pass; owns source and version. */
  execution?: ArtifactExecution;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(scene));
  const [synced, setSynced] = useState<Draft>(() => draftFrom(scene));
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const stored = draftFrom(scene);
  const dirty = FIELDS.some((f) => draft[f.key] !== synced[f.key]);

  // These prompts can be rewritten while the panel is open — editing the scene
  // card offers to rewrite them, and so does regenerating the storyboard. The
  // draft is seeded once at mount, so without this it keeps showing the old
  // text until the page is reloaded. Unsaved edits are never discarded.
  if (FIELDS.some((f) => stored[f.key] !== synced[f.key])) {
    setSynced(stored);
    if (!dirty) setDraft(stored);
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to save prompts (HTTP ${res.status})`);
      }
      const record = (await res.json()) as ProjectRecord;
      onSaved?.(record);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompts");
    } finally {
      setSaving(false);
    }
  };

  const rewrite = async () => {
    setRewriting(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
        method: "POST",
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to rewrite prompts (HTTP ${res.status})`);
      }
      const record = (await res.json()) as ProjectRecord;
      const next = record.storyboard?.scenes.find((s) => s.id === scene.id);
      // An explicit rewrite is meant to replace what is on screen, including
      // unsaved edits, so both are set rather than leaving it to the sync.
      if (next) {
        setDraft(draftFrom(next));
        setSynced(draftFrom(next));
      }
      onSaved?.(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rewrite prompts");
    } finally {
      setRewriting(false);
    }
  };

  const disabled = busy || saving || rewriting;

  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-slate-300">
        Prompts
        <span className="ml-2 text-[11px] text-slate-500">
          sent to WanGP · editable
          {dirty ? " · unsaved changes" : ""}
        </span>
      </summary>

      {execution ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <ExecutionBadge execution={execution} />
          {execution.composerVersion ? <span>Composer {execution.composerVersion}</span> : null}
          {execution.promptVersion ? <span>Prompt {execution.promptVersion}</span> : null}
        </p>
      ) : null}

      <div className="mt-2 space-y-3">
        {FIELDS.map((field) => {
          const words = triggerWords?.[field.kind] ?? [];
          const isNegative = field.key.toLowerCase().includes("negative");
          const pending = isNegative
            ? []
            : words.filter((w) => !new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(draft[field.key]));
          const notes = lintField(field.key, draft[field.key], scene);
          // Placed against the field it describes: reference mode reshapes the
          // clip prompt and nothing else, so a note at the top of the panel
          // reads as though it applied to the keyframes too.
          const wrapped = field.key === "videoPromptSegment" && videoFamily === "minimax_ref2va";

          return (
            <div key={field.key} className="space-y-1">
              {wrapped ? (
                <p className="rounded-md border border-white/10 bg-canvas/40 px-3 py-2 text-[11px] text-slate-400">
                  <strong className="text-slate-300">Reference mode reshapes this at generation.</strong>{" "}
                  What reaches WanGP is this text inside MiniMax&apos;s six labelled sections, led
                  by lines naming each reference picture — the two keyframes, then one photograph
                  per character in the scene. Those lines are built from the cast at render time
                  rather than stored, because the cast can change after a prompt is written; they
                  are not editable here. The prose below is sent as you write it.
                </p>
              ) : null}
              <label className="block space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  {field.label}
                </span>
                <textarea
                  rows={field.rows}
                  disabled={disabled}
                  value={draft[field.key]}
                  onChange={(e) =>
                    setDraft((current) => ({ ...current, [field.key]: e.target.value }))
                  }
                  className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent disabled:opacity-60"
                />
                {notes.length ? (
                  <ul data-testid="prompt-lint" className="space-y-0.5">
                    {notes.map((note) => (
                      <li key={note} className="text-[10px] text-amber-300/90">
                        Warning: {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {pending.length ? (
                  <span className="block text-[10px] text-amber-300/80">
                    LoRA trigger words appended at generation: {pending.join(", ")}
                  </span>
                ) : null}
              </label>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save()}
            className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save prompts"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => setDraft(stored)}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            Revert
          </button>
          <button
            type="button"
            disabled={disabled || rewriting}
            onClick={() => void rewrite()}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
            title="Ask the prompt agents to write this scene's prompts again from its card"
          >
            {rewriting ? "Rewriting…" : "Regenerate these prompts"}
          </button>
          {saved && !dirty ? <span className="text-xs text-emerald-400">Saved.</span> : null}
          {error ? <span className="text-xs text-red-300">{error}</span> : null}
        </div>

        <p className="text-[10px] text-slate-600">
          Edits apply to this scene only and take effect on the next generation. Regenerating the
          storyboard rewrites them. <strong>Regenerate these prompts</strong> rewrites this scene
          alone, from its existing card — the card, the other scenes and their hand edits are left
          as they are.
        </p>

        {scene.prompts.promptQualityChecklist.length ? (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Quality checklist</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {scene.prompts.promptQualityChecklist.map((item) => (
                <li key={item} className="text-[11px] text-slate-500">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
