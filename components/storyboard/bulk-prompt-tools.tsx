"use client";

import { useId, useState } from "react";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import { countWords } from "@/lib/agents/media-prompt-spec";
import {
  PROMPT_FIELD_LABELS,
  promptPreviewSchema,
  type PromptPreview,
} from "@/lib/schemas/prompt-tools";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

type Scope = "all" | "selected";
type Frames = "start" | "end" | "both";

const controlClass = "rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-sm";
const buttonClass = "rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50";

function PromptScope({
  scenes, scope, onScope, picked, onPicked,
}: {
  scenes: Scene[];
  scope: Scope;
  onScope: (scope: Scope) => void;
  picked: string[];
  onPicked: (picked: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        Scenes
        <select className={controlClass} value={scope} onChange={(e) => onScope(e.target.value === "all" ? "all" : "selected")}>
          <option value="all">All scenes</option>
          <option value="selected">Selected scenes</option>
        </select>
      </label>
      {scope === "selected" ? <ScenePicker scenes={scenes} picked={picked} onChange={onPicked} /> : null}
    </div>
  );
}

function FrameSelection({ value, onChange }: { value: Frames; onChange: (value: Frames) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      Image frames
      <select className={controlClass} value={value} onChange={(e) => {
        const next = e.target.value;
        if (next === "start" || next === "end" || next === "both") onChange(next);
      }}>
        <option value="both">Start and end frames</option>
        <option value="start">Start frame only</option>
        <option value="end">End frame only</option>
      </select>
    </label>
  );
}

export function BulkPromptTools({
  projectId, scenes, disabled, onSaved, onBusyChange,
}: {
  projectId: string;
  scenes: Scene[];
  disabled: boolean;
  onSaved: (record: ProjectRecord) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const [addScope, setAddScope] = useState<Scope>("selected");
  const [addPicks, setAddPicks] = useState<string[]>([]);
  const [addFrames, setAddFrames] = useState<Frames>("both");
  const [text, setText] = useState("");
  const [placement, setPlacement] = useState<"append" | "prepend">("append");
  const [scope, setScope] = useState<Scope>("all");
  const [picks, setPicks] = useState<string[]>([]);
  const [frames, setFrames] = useState<Frames>("both");
  const [target, setTarget] = useState<"image" | "video" | "both">("both");
  const [working, setWorking] = useState<"add" | "preview" | "apply" | null>(null);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const keyOf = (row: PromptPreview["results"][number]) => `${row.sceneId}:${row.field}`;
  const selected = preview?.results.filter((row) => row.status === "ready" && checked.includes(keyOf(row))) ?? [];
  const unavailable = disabled || working !== null;

  async function request(action: "add" | "preview" | "apply") {
    setWorking(action);
    onBusyChange(true);
    setError(null);
    setNotice(null);
    if (action === "preview") {
      setPreview(null);
      setChecked([]);
    }
    try {
      const body = action === "add"
        ? { scope: addScope, sceneIds: addPicks, frames: addFrames, text, placement }
        : action === "preview"
          ? { scope, sceneIds: picks, frames, target }
          : { results: selected };
      const response = await fetch(
        `/api/projects/${projectId}/prompts/${action === "add" ? "add-text" : "simplify"}`,
        {
          method: action === "apply" ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Prompt operation failed (HTTP ${response.status}).`);
      }
      if (action === "preview") {
        const next = promptPreviewSchema.parse(await response.json());
        setPreview(next);
        setChecked(next.results.filter((row) => row.status === "ready").map(keyOf));
      } else {
        onSaved(await response.json() as ProjectRecord);
        setPreview(null);
        setChecked([]);
        if (action === "add") setText("");
        setNotice(action === "add"
          ? "Text added to the chosen image prompts. Existing media is unchanged."
          : `Applied ${selected.length} simplified prompt${selected.length === 1 ? "" : "s"}. Existing media is unchanged. Preview again for any remaining prompts.`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Prompt operation failed.");
    } finally {
      setWorking(null);
      onBusyChange(false);
    }
  }

  return (
    <div data-testid="bulk-prompt-tools" className="space-y-3">
      <details className="mt-3 rounded-md border border-white/10 bg-black/20">
        <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
          Add text to image prompts
        </summary>
        <fieldset disabled={unavailable} className="space-y-3 px-3 pb-3 disabled:opacity-60">
          <p className="text-xs text-slate-500">
            Add your text literally, without an AI rewrite. Only the chosen frames change.
            Scene cards, negative prompts and rendered media are kept. Regenerate keyframes separately to see the change.
          </p>
          <PromptScope scenes={scenes} scope={addScope} onScope={setAddScope} picked={addPicks} onPicked={setAddPicks} />
          <FrameSelection value={addFrames} onChange={setAddFrames} />
          <label className="flex items-center gap-2 text-xs">
            Placement
            <select className={controlClass} value={placement} onChange={(e) => setPlacement(e.target.value === "prepend" ? "prepend" : "append")}>
              <option value="append">Append to the end</option>
              <option value="prepend">Prepend to the beginning</option>
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>Text to add</span>
            <textarea className={`${controlClass} w-full`} rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <button type="button" className={buttonClass} disabled={!text.trim() || (addScope === "selected" && !addPicks.length)} onClick={() => void request("add")}>
            {working === "add" ? "Adding text…" : "Apply text to image prompts"}
          </button>
        </fieldset>
      </details>

      <details className="rounded-md border border-white/10 bg-black/20">
        <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
          Simplify image and video prompts
        </summary>
        <fieldset disabled={unavailable} className="space-y-3 px-3 pb-3 disabled:opacity-60">
          <p className="text-xs text-slate-500">
            Shorten existing prompts, not rewrite from scratch. Uses your configured planning model
            to preserve people, positions and actions with concise, positive wording.
            Review before applying. Negative prompts, scene cards and media are unchanged.
          </p>
          <PromptScope scenes={scenes} scope={scope} onScope={setScope} picked={picks} onPicked={setPicks} />
          <label className="flex items-center gap-2 text-xs">
            Prompts to simplify
            <select className={controlClass} value={target} onChange={(e) => {
              const next = e.target.value;
              if (next === "image" || next === "video" || next === "both") setTarget(next);
            }}>
              <option value="both">Image and video prompts</option>
              <option value="image">Image prompts only</option>
              <option value="video">Video prompts only</option>
            </select>
          </label>
          {target !== "video" ? <FrameSelection value={frames} onChange={setFrames} /> : null}
          <button type="button" className={buttonClass} disabled={scope === "selected" && !picks.length} onClick={() => void request("preview")}>
            {working === "preview" ? "Simplifying prompts…" : "Preview simplified prompts"}
          </button>
          {working === "preview" ? <p role="status" className="text-xs text-accent">Processing prompts one at a time. Nothing is saved until you apply the preview. Keep this page open.</p> : null}
          {preview ? (
            <div className="space-y-3" aria-label="Simplification preview">
              <p className="text-xs text-slate-400">This preview keeps the scope chosen when it was requested. Check only the results you want to save; discard leaves every prompt unchanged.</p>
              <div className="max-h-[36rem] space-y-3 overflow-y-auto">
                {preview.results.map((row, index) => {
                  const key = keyOf(row);
                  const label = `Scene ${row.sceneNumber} · ${PROMPT_FIELD_LABELS[row.field]}`;
                  return (
                    <div key={key} className="space-y-2 rounded-md border border-white/10 p-3">
                      {row.status === "ready" ? (
                        <label className="flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={checked.includes(key)} onChange={(e) => setChecked((current) => e.target.checked ? [...current, key] : current.filter((value) => value !== key))} />
                          Apply {label}
                        </label>
                      ) : <p className="text-xs">{label}</p>}
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <label htmlFor={`${id}-${index}-before`} className="text-xs text-slate-400">Before · {countWords(row.before)} words</label>
                          <textarea id={`${id}-${index}-before`} readOnly rows={5} value={row.before} className={`${controlClass} w-full`} />
                        </div>
                        {row.status === "ready" ? (
                          <div>
                            <label htmlFor={`${id}-${index}-after`} className="text-xs text-slate-400">After · {countWords(row.after)} words</label>
                            <textarea id={`${id}-${index}-after`} readOnly rows={5} value={row.after} className={`${controlClass} w-full`} />
                          </div>
                        ) : <p role="alert" className="text-xs text-red-300">{row.error}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <button type="button" className={buttonClass} disabled={!selected.length} onClick={() => void request("apply")}>
                  {working === "apply" ? "Applying prompts…" : `Apply ${selected.length} selected prompt${selected.length === 1 ? "" : "s"}`}
                </button>
                <button type="button" className={buttonClass} onClick={() => { setPreview(null); setChecked([]); setError(null); }}>
                  Discard preview
                </button>
              </div>
            </div>
          ) : null}
        </fieldset>
      </details>
      {disabled && !working ? <p className="text-xs text-amber-200">Bulk prompt tools are unavailable while generation or another planning operation is running.</p> : null}
      {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
      {notice ? <p role="status" className="text-xs text-emerald-300">{notice}</p> : null}
    </div>
  );
}
