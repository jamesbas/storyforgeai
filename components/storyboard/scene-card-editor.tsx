"use client";

import { useState } from "react";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";
import type { DialogueLine } from "@/lib/schemas/audio";
import type { DialogueMode } from "@/lib/types";
import { DIALOGUE_MODE_LABELS } from "@/lib/schemas/card-feedback";
import {
  countSpokenWords,
  inferDialogueMode,
  lintDialogue,
  sceneSpeechTargets,
  WORDS_PER_SECOND,
} from "@/lib/agents/media-prompt-spec";

/** The story content a person may correct. Timing and identity are derived. */
const FIELDS = [
  { key: "title", label: "Title", rows: 1 },
  { key: "sceneObjective", label: "Objective", rows: 2 },
  { key: "storyBeat", label: "Story beat", rows: 2 },
  { key: "visualDescription", label: "Visual", rows: 3 },
  { key: "actionDescription", label: "Action", rows: 3 },
  { key: "cameraMovement", label: "Camera", rows: 1 },
  { key: "narrationText", label: "Voice-over (from outside the scene)", rows: 2 },
  { key: "startVisible", label: "People visible in the opening frame (comma-separated names/roles)", rows: 2 },
  { key: "endVisible", label: "People visible in the closing frame (comma-separated names/roles)", rows: 2 },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Draft = Record<FieldKey, string>;

function draftFrom(scene: Scene): Draft {
  return {
    title: scene.title,
    sceneObjective: scene.sceneObjective,
    storyBeat: scene.storyBeat,
    visualDescription: scene.visualDescription,
    actionDescription: scene.actionDescription,
    cameraMovement: scene.cameraMovement,
    narrationText: scene.narrationText ?? "",
    startVisible: scene.frameVisibility?.start.join(", ") ?? "",
    endVisible: scene.frameVisibility?.end.join(", ") ?? "",
  };
}

const linesFrom = (scene: Scene): DialogueLine[] =>
  (scene.dialogue ?? []).map((d) => ({ character: d.character, line: d.line }));

/** The mode the scene behaves as: stored, or read from its lines. */
const modeFrom = (scene: Scene): DialogueMode => inferDialogueMode(scene.dialogue, scene.dialogueMode);
const intentFrom = (scene: Scene): string => scene.dialogueIntent ?? "";

const sameLines = (a: DialogueLine[], b: DialogueLine[]) =>
  a.length === b.length && a.every((l, i) => l.character === b[i]!.character && l.line === b[i]!.line);

/**
 * The scene card, editable in place.
 *
 * Every prompt for this scene is written from this text, so a card describing
 * the wrong shot cannot be corrected downstream — a prompt agent given "the
 * men's hands are seen" writes a shot of hands however often it is asked. The
 * prompts were editable long before the card was, which had it backwards.
 */
export function SceneCardEditor({
  scene,
  projectId,
  busy = false,
  onSaved,
}: {
  scene: Scene;
  projectId: string;
  busy?: boolean;
  onSaved?: (record: ProjectRecord) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(scene));
  const [synced, setSynced] = useState<Draft>(() => draftFrom(scene));
  const [lines, setLines] = useState<DialogueLine[]>(() => linesFrom(scene));
  const [syncedLines, setSyncedLines] = useState<DialogueLine[]>(() => linesFrom(scene));
  const [mode, setMode] = useState<DialogueMode>(() => modeFrom(scene));
  const [syncedMode, setSyncedMode] = useState<DialogueMode>(() => modeFrom(scene));
  const [intent, setIntent] = useState<string>(() => intentFrom(scene));
  const [syncedIntent, setSyncedIntent] = useState<string>(() => intentFrom(scene));
  const [guidance, setGuidance] = useState("");
  const [updateVideo, setUpdateVideo] = useState(() => Boolean(scene.prompts.videoPromptSegment.trim()));
  const [saving, setSaving] = useState<null | "card" | "prompts" | "dialogue">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const stored = draftFrom(scene);
  const storedLines = linesFrom(scene);
  const storedMode = modeFrom(scene);
  const storedIntent = intentFrom(scene);
  const dirty =
    FIELDS.some((f) => draft[f.key] !== synced[f.key]) || !sameLines(lines, syncedLines) ||
    mode !== syncedMode || intent !== syncedIntent;

  // Regenerating the storyboard replaces this card while the panel may be open.
  // The draft is seeded once at mount, so without this it keeps showing the
  // card that was replaced. Unsaved edits are never discarded.
  //
  // Per field, for the reason set out in the prompts panel: one unsaved box
  // must not strand the other six, or the editor goes on believing it is in
  // step while holding text the storyboard has already replaced — and writes
  // that text back over the replacement on the next save.
  const drifted = FIELDS.filter((f) => stored[f.key] !== synced[f.key]);
  if (drifted.length) {
    setSynced(stored);
    setDraft((current) => {
      let adopted = false;
      const next = { ...current };
      for (const f of drifted) {
        // Only where this box holds no unsaved edit of its own.
        if (current[f.key] === synced[f.key]) {
          next[f.key] = stored[f.key];
          adopted = true;
        }
      }
      return adopted ? next : current;
    });
  }
  // The dialogue moves as one: a line only means anything beside its
  // neighbours, so a half-adopted list would be neither version.
  if (!sameLines(storedLines, syncedLines)) {
    setSyncedLines(storedLines);
    if (sameLines(lines, syncedLines)) setLines(storedLines);
  }
  if (storedMode !== syncedMode) {
    setSyncedMode(storedMode);
    if (mode === syncedMode) setMode(storedMode);
  }
  if (storedIntent !== syncedIntent) {
    setSyncedIntent(storedIntent);
    if (intent === syncedIntent) setIntent(storedIntent);
  }

  const spokenWords = countSpokenWords(lines);
  const seconds = scene.trimAtEndSeconds ?? scene.targetDurationSeconds;
  const speech = { mode, narrationText: draft.narrationText };
  const speechTargets = sceneSpeechTargets(lines, seconds, speech);
  const dialogueFindings = lintDialogue(lines, seconds, speech);
  const speechSeconds = spokenWords / WORDS_PER_SECOND;
  const coverage = Math.round((speechSeconds / Math.max(1, seconds)) * 100);

  /** Silent clears the lines (Revert brings them back); a line added to a silent scene makes it brief. */
  const chooseMode = (next: DialogueMode) => {
    setDone(null);
    setMode(next);
    if (next === "silent") setLines([]);
  };

  const save = async (thenRewrite: boolean) => {
    // Only what was actually edited. Sending the whole card wrote this
    // editor's copy of every untouched field back over whatever was stored.
    const edited = FIELDS.filter((f) => draft[f.key] !== synced[f.key]);
    const linesEdited = !sameLines(lines, syncedLines);
    const modeEdited = mode !== syncedMode;
    const intentEdited = intent !== syncedIntent;
    if (!edited.length && !linesEdited && !modeEdited && !intentEdited) return;

    const dialogue = lines.filter((l) => l.character.trim() && l.line.trim());
    const fields = Object.fromEntries(edited.map((f) => [f.key, draft[f.key]]));
    const patch: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== "startVisible" && key !== "endVisible"),
    );
    if (edited.some((field) => field.key === "startVisible" || field.key === "endVisible")) {
      const names = (text: string) => [...new Set(text.split(",").map((name) => name.trim()).filter(Boolean))];
      patch.frameVisibility = { start: names(draft.startVisible), end: names(draft.endVisible) };
    }
    if (linesEdited) patch.dialogue = dialogue;
    if (modeEdited) patch.dialogueMode = mode;
    if (intentEdited) patch.dialogueIntent = intent.trim();

    setSaving(thenRewrite ? "prompts" : "card");
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/card`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Failed to save the card (HTTP ${res.status})`);
      }
      let record = (await res.json()) as ProjectRecord;

      if (thenRewrite) {
        const rewrite = await fetch(`/api/projects/${projectId}/scenes/${scene.id}/prompts`, {
          method: "POST",
        });
        if (!rewrite.ok) {
          const detail = (await rewrite.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Card saved, but rewriting prompts failed`);
        }
        record = (await rewrite.json()) as ProjectRecord;
      }

      // Marked clean from what was sent, not from the prop round-trip, and the
      // dialogue settles on the filtered list so a blank row left behind in the
      // editor does not read as an unsaved change for ever.
      setSynced((current) => ({ ...current, ...fields }));
      if (linesEdited) {
        setLines(dialogue);
        setSyncedLines(dialogue);
      }
      if (modeEdited) setSyncedMode(mode);
      if (intentEdited) {
        setIntent(intent.trim());
        setSyncedIntent(intent.trim());
      }
      setDone(thenRewrite ? "Card saved and prompts rewritten." : "Card saved.");
      onSaved?.(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the card");
    } finally {
      setSaving(null);
    }
  };

  const disabled = busy || saving !== null;

  const rewriteDialogue = async () => {
    setSaving("dialogue");
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dialogue/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sceneIds: [scene.id],
          modeOverride: mode,
          ...(guidance.trim() ? { instruction: guidance.trim() } : {}),
          rewriteVideoPrompts: updateVideo,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        record?: ProjectRecord;
        updatedSceneIds?: string[];
        warnings?: Record<string, string[]>;
        promptError?: string;
        error?: string;
      } | null;
      if (!res.ok || !body?.record) throw new Error(body?.error ?? `Failed to rewrite the dialogue (HTTP ${res.status})`);
      if (body.promptError) setError(body.promptError);
      const still = body.warnings?.[scene.id]?.length ? " Its length still needs a look." : "";
      setDone(body.updatedSceneIds?.includes(scene.id)
        ? `Dialogue rewritten${updateVideo && !body.promptError ? " and video prompt updated" : ""}.${still}`
        : "The writer kept the existing dialogue.");
      onSaved?.(body.record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rewrite the dialogue");
    } finally {
      setSaving(null);
    }
  };

  return (
    <details className="mt-3 text-sm" data-testid="scene-card-editor">
      <summary className="cursor-pointer text-slate-300">
        Scene card
        <span className="ml-2 text-[11px] text-slate-500">
          what the prompts are written from · editable
          {dirty ? " · unsaved changes" : ""}
        </span>
      </summary>

      <p className="mt-2 text-xs text-slate-500">
        Prompts are written from this text, so correcting the card is how you change what the shot
        contains. Rewriting a scene&apos;s prompts without changing the card produces the same shot
        again.
        {" "}Visibility lists include non-library people. Once either list is edited, an empty
        list means nobody is visible in that frame. Use exact names from the card.
      </p>

      <div className="mt-2 space-y-3">
        {FIELDS.map((field) => (
          <label key={field.key} className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{field.label}</span>
            <textarea
              rows={field.rows}
              disabled={disabled}
              value={draft[field.key]}
              onChange={(e) => {
                setDone(null);
                setDraft((current) => ({ ...current, [field.key]: e.target.value }));
              }}
              className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
        ))}

        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            Dialogue
            <span className="ml-2 normal-case tracking-normal text-slate-600" data-testid="dialogue-readout">
              {mode === "silent"
                ? `Silent · no spoken lines in ${seconds}s`
                : `${spokenWords} spoken words · about ${speechSeconds.toFixed(1)}s of ${seconds}s (${coverage}%)` +
                  ` · target ${speechTargets.targetMin}–${speechTargets.targetMax} words` +
                  (speechTargets.narrationSeconds > 0 ? ` after ${speechTargets.narrationSeconds.toFixed(1)}s of voice-over` : "")}
            </span>
          </span>
          <p className="text-xs text-slate-500">
            Spoken aloud by the video model, word for word. This is the only source of speech in
            the clip. A Full scene talks through most of the clip while the action continues; a
            Brief one has a short line or two; a Silent one has none. Stage directions in brackets
            are not counted. Timing is estimated.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-[11px] uppercase tracking-wide text-slate-500">Dialogue mode</span>
              <select
                value={mode}
                disabled={disabled}
                aria-label="Dialogue mode"
                onChange={(e) => chooseMode(e.target.value as DialogueMode)}
                className="rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              >
                {(["full", "brief", "silent"] as const).map((value) => (
                  <option key={value} value={value}>{DIALOGUE_MODE_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[16rem] flex-1 space-y-1">
              <span className="block text-[11px] uppercase tracking-wide text-slate-500">Dialogue intent</span>
              <input
                type="text"
                value={intent}
                maxLength={400}
                disabled={disabled}
                placeholder="What is verbally at stake, or why the scene is silent"
                onChange={(e) => {
                  setDone(null);
                  setIntent(e.target.value);
                }}
                className="w-full rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
            </label>
          </div>
          {dialogueFindings.length ? (
            <div className="text-xs text-amber-300" aria-live="polite" data-testid="dialogue-warning">
              {dialogueFindings.map((finding) => <p key={finding.code}>{finding.message}</p>)}
            </div>
          ) : null}
          {lines.map((line, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="text"
                value={line.character}
                disabled={disabled}
                placeholder="Who"
                aria-label={`Speaker ${index + 1}`}
                onChange={(e) => {
                  setDone(null);
                  setLines((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, character: e.target.value } : r)),
                  );
                }}
                className="w-1/4 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <textarea
                rows={2}
                value={line.line}
                disabled={disabled}
                placeholder="What they say"
                aria-label={`Line ${index + 1}`}
                onChange={(e) => {
                  setDone(null);
                  setLines((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, line: e.target.value } : r)),
                  );
                }}
                className="flex-1 rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setDone(null);
                  setLines((rows) => rows.filter((_, i) => i !== index));
                }}
                className="rounded-md border border-white/10 px-2 text-xs text-slate-400 hover:border-red-500/50 hover:text-red-300"
                aria-label={`Remove line ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDone(null);
              setLines((rows) => [...rows, { character: "", line: "" }]);
              if (mode === "silent") setMode("brief");
            }}
            className="rounded-md border border-white/15 px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          >
            Add a line
          </button>

          <div className="space-y-2 rounded-md border border-white/10 p-2" data-testid="dialogue-rewrite">
            <label className="block space-y-1">
              <span className="block text-[11px] uppercase tracking-wide text-slate-500">
                Rewrite dialogue — guidance (optional)
              </span>
              <input
                type="text"
                value={guidance}
                maxLength={500}
                disabled={disabled}
                placeholder="e.g. make it tenser, focus on the negotiation"
                onChange={(e) => setGuidance(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-canvas px-2 py-1 text-sm"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={disabled || dirty || mode === "silent"}
                onClick={() => void rewriteDialogue()}
                className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:border-accent disabled:opacity-50"
              >
                {saving === "dialogue" ? "Rewriting dialogue…" : "Rewrite dialogue"}
              </button>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={updateVideo}
                  disabled={disabled}
                  onChange={(e) => setUpdateVideo(e.target.checked)}
                />
                Also update the video prompt
              </label>
            </div>
            <p className="text-[10px] text-slate-600">
              {dirty
                ? "Save or revert your edits first — the writer works from the saved card."
                : mode === "silent"
                  ? "A silent scene has nothing to write. Choose Brief or Full to write lines."
                  : `Writes ${DIALOGUE_MODE_LABELS[mode].toLowerCase()} dialogue from this card. Keyframes and image prompts are not touched.`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save(true)}
            className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving === "prompts" ? "Saving and rewriting…" : "Save and rewrite prompts"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => void save(false)}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            {saving === "card" ? "Saving…" : "Save card only"}
          </button>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => {
              setDone(null);
              setDraft(stored);
              setLines(storedLines);
              setMode(storedMode);
              setIntent(storedIntent);
            }}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
          >
            Revert
          </button>
          {done ? <span className="text-xs text-emerald-400">{done}</span> : null}
          {error ? <span className="text-xs text-red-300">{error}</span> : null}
        </div>

        <p className="text-[10px] text-slate-600">
          Saving the card alone leaves the existing prompts in place, so they will still describe the
          old shot until they are rewritten. Regenerating the whole storyboard replaces this card.
        </p>
      </div>
    </details>
  );
}
