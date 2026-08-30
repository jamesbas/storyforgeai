"use client";

import { useCallback, useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import {
  ALL_SCOPES_REQUIRED,
  MAX_SYSTEM_PROMPT_CHARACTERS,
  type SystemPromptSettings,
} from "@/lib/schemas/system-prompt-settings";

type Draft = { agenticCanvas: string; storyboard: string; renderPrompts: string };
const EMPTY: Draft = { agenticCanvas: "", storyboard: "", renderPrompts: "" };

const draftOf = (settings: SystemPromptSettings): Draft => ({
  agenticCanvas: settings.agenticCanvas ?? "",
  storyboard: settings.storyboard ?? "",
  renderPrompts: settings.renderPrompts ?? "",
});

const textarea =
  "mt-1 min-h-40 w-full resize-y rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent";

export function SystemPromptSettingsForm() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings/system-prompts", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load system prompt settings");
      const body = (await res.json()) as { settings: SystemPromptSettings };
      if (!isCurrent()) return;
      setDraft(draftOf(body.settings));
      setLoaded(true);
    } catch (error) {
      if (!isCurrent()) return;
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not load system prompt settings");
    }
  }, []);

  useLoadEffect(load);

  const save = useCallback(async (next: Draft) => {
    const filled = [next.agenticCanvas, next.storyboard, next.renderPrompts].filter((value) =>
      value.trim(),
    );
    if (filled.length > 0 && filled.length < 3) {
      setFailed(true);
      setStatus(ALL_SCOPES_REQUIRED);
      return;
    }

    setBusy(true);
    setFailed(false);
    setStatus("Saving...");
    try {
      const res = await fetch("/api/settings/system-prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save system prompt settings");
      }
      const body = (await res.json()) as { settings: SystemPromptSettings };
      setDraft(draftOf(body.settings));
      setStatus(
        filled.length === 3 ? "Custom system prompts saved." : "Using built-in system prompts.",
      );
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not save system prompt settings");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <CollapsibleSection
      testId="system-prompts-section"
      title="LM Studio system prompts"
      description="Optional app-wide creative direction for future AI planning calls. Each scope reaches a different set of agents, and all three are required when enabled. StoryForgeAI keeps its built-in artifact, continuity, and JSON requirements after your instructions so generated work remains valid."
    >

      <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3">
        <p className="text-xs font-semibold text-amber-200">
          Instructions written for the wrong scope degrade every project
        </p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-slate-400">
          <li>
            Keep render rules out of the planning scopes. Telling a narrative agent to write stills
            makes it write prompts instead of the scene card it was asked for.
          </li>
          <li>
            Never restate a character&apos;s appearance. The character library already appends it per
            scene, and describing someone twice renders them twice.
          </li>
          <li>
            Never redefine a JSON field such as <code>charactersPresent</code>. StoryForgeAI&apos;s
            own definition still applies and the two will contradict each other.
          </li>
          <li>
            Keep each prompt short. It is sent on every model call — roughly fifty on a 24-scene
            project — and competes with the context the agents need.
          </li>
        </ul>
        <p className="mt-2 text-xs text-slate-400">
          <a href="/help#systemprompts" className="text-accent underline underline-offset-2">
            Read the full guidance in Help
          </a>{" "}
          before writing these.
        </p>
      </div>

      {loaded ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <PromptField
            id="agentic-canvas-system-prompt"
            label="Agentic Canvas system prompt"
            description="Variant Explorer, World Builder, Director, Cinematographer, Art Director. Planning only — these agents never write render prompts."
            value={draft.agenticCanvas}
            disabled={busy}
            onChange={(agenticCanvas) => setDraft((current) => ({ ...current, agenticCanvas }))}
          />
          <PromptField
            id="storyboard-system-prompt"
            label="Storyboard system prompt"
            description="Intake, Story Architect, Visual Bible, Storyboard Artist. Writes the brief, arc, continuity guide and scene cards — not image or video prompts."
            value={draft.storyboard}
            disabled={busy}
            onChange={(storyboard) => setDraft((current) => ({ ...current, storyboard }))}
          />
          <PromptField
            id="render-prompts-system-prompt"
            label="Render prompt system prompt"
            description="Image Prompt and Video Prompt agents. The only scope that writes the text sent to the image and video models."
            value={draft.renderPrompts}
            disabled={busy}
            onChange={(renderPrompts) => setDraft((current) => ({ ...current, renderPrompts }))}
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save system prompts
            </button>
            <button
              type="button"
              disabled={busy || !Object.values(draft).some(Boolean)}
              onClick={() => void save(EMPTY)}
              className="rounded-md border border-white/15 px-4 py-2 text-sm text-slate-300 hover:border-accent hover:text-white disabled:opacity-50"
            >
              Clear custom prompts
            </button>
          </div>
        </form>
      ) : null}

      <AsyncStatus testId="system-prompts-status" message={status} failed={failed} busy={busy} />
    </CollapsibleSection>
  );
}

function PromptField({
  id,
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
      </label>
      <p id={`${id}-description`} className="mt-0.5 text-xs text-slate-500">
        {description}
      </p>
      <textarea
        id={id}
        value={value}
        maxLength={MAX_SYSTEM_PROMPT_CHARACTERS}
        disabled={disabled}
        aria-describedby={`${id}-description ${id}-count`}
        onChange={(event) => onChange(event.target.value)}
        className={textarea}
      />
      <p id={`${id}-count`} className="mt-1 text-right text-xs text-slate-500">
        {value.length.toLocaleString()} / {MAX_SYSTEM_PROMPT_CHARACTERS.toLocaleString()}
      </p>
    </div>
  );
}