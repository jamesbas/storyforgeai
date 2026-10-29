"use client";

import { useCallback, useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import {
  PLANNING_MODELS,
  PLANNING_STAGES,
  PLANNING_STAGE_LABELS,
  type PlanningModelSettingsView,
  type PlanningStage,
} from "@/lib/schemas/planning-model-settings";

type Key = "model" | PlanningStage;
type Fields = Record<Key, string>;

/** The select value that reveals the free-text box. */
const CUSTOM = "__custom__";

const toFields = (settings: PlanningModelSettingsView): Fields => ({
  model: settings.model ?? "",
  storyboard: settings.stages.storyboard ?? "",
  agentic_canvas: settings.stages.agentic_canvas ?? "",
  render_prompts: settings.stages.render_prompts ?? "",
});

/** An empty value means "follow the default"; anything else is a model id. */
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

const controlClass =
  "w-full rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent";

export function PlanningModelSettingsForm() {
  const [settings, setSettings] = useState<PlanningModelSettingsView | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  // Boxes the user opened to type an id, whatever the id currently is.
  const [typing, setTyping] = useState<Partial<Record<Key, boolean>>>({});
  const [available, setAvailable] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>("Loading planning models...");

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings/planning-model", { cache: "no-store" });
      const body = (await res.json()) as {
        settings: PlanningModelSettingsView;
        available?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not load planning model settings.");
      if (!isCurrent()) return;
      setSettings(body.settings);
      setFields(toFields(body.settings));
      setAvailable(body.available ?? []);
      setStatus(null);
    } catch (error) {
      if (!isCurrent()) return;
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not load planning model settings.");
    }
  }, []);

  useLoadEffect(load);

  const save = async (next: Fields) => {
    setBusy(true);
    setFailed(false);
    setStatus("Saving...");
    try {
      const res = await fetch("/api/settings/planning-model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: orNull(next.model),
          stages: Object.fromEntries(PLANNING_STAGES.map((stage) => [stage, orNull(next[stage])])),
        }),
      });
      const body = (await res.json()) as { settings: PlanningModelSettingsView; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save planning model settings.");
      setSettings(body.settings);
      setFields(toFields(body.settings));
      setTyping({});
      setStatus(`Saved. Future AI planning calls will use ${body.settings.effectiveModel} by default.`);
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not save planning model settings.");
    } finally {
      setBusy(false);
    }
  };

  const serverModels = available;
  const presets = PLANNING_MODELS.filter((model) => !available.includes(model));
  const listed = new Set<string>([...serverModels, ...presets]);

  const picker = (key: Key, id: string, label: string, followLabel: string, detail?: string) => {
    const value = fields![key];
    // A saved id that is in neither list is shown as typed, not silently dropped.
    const custom = typing[key] === true || (value !== "" && !listed.has(value));
    return (
      <div key={key} className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <select
          id={id}
          className={controlClass}
          value={custom ? CUSTOM : value}
          disabled={busy}
          onChange={(event) => {
            const choice = event.target.value;
            if (choice === CUSTOM) {
              setTyping((current) => ({ ...current, [key]: true }));
              return;
            }
            setTyping((current) => ({ ...current, [key]: false }));
            setFields((current) => (current ? { ...current, [key]: choice } : current));
          }}
        >
          <option value="">{followLabel}</option>
          {serverModels.length ? (
            <optgroup label="On the LM Studio server">
              {serverModels.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </optgroup>
          ) : null}
          {presets.length ? (
            <optgroup label="Presets">
              {presets.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </optgroup>
          ) : null}
          <option value={CUSTOM}>Other model id…</option>
        </select>
        {custom ? (
          <input
            aria-label={`${label}, model id`}
            className={controlClass}
            value={value}
            disabled={busy}
            placeholder="Type the model id exactly as the server names it"
            onChange={(event) =>
              setFields((current) => (current ? { ...current, [key]: event.target.value } : current))
            }
          />
        ) : null}
        {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
      </div>
    );
  };

  return (
    <CollapsibleSection
      testId="planning-model-section"
      title="AI planning models"
      description="Choose the text model for AI planning calls in every project, and optionally a different one for each stage. Saved across restarts without editing .env.local. Existing artifacts and in-flight requests are unchanged."
    >
      {settings && fields ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save(fields);
          }}
        >
          {picker(
            "model",
            "planning-model",
            "Planning model",
            `Use environment default (${settings.defaultModel})`,
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {PLANNING_STAGES.map((stage) =>
              picker(
                stage,
                `planning-model-${stage}`,
                PLANNING_STAGE_LABELS[stage].title,
                `Same as planning model (${fields.model || settings.defaultModel})`,
                PLANNING_STAGE_LABELS[stage].detail,
              ),
            )}
          </div>
          <p id="planning-model-help" className="text-xs text-slate-400">
            The lists show the text models LM Studio reports plus a few presets; pick{" "}
            <em>Other model id…</em> for one that is not listed, such as a model released after
            this version. The planning model follows OPENAI_MODEL (gpt-4o-mini when unset) when
            left on the default, and a stage left on &quot;Same as planning model&quot; follows it.
            A different model per stage can be worth it — a larger one for the story, a smaller
            one for the many short prompt calls — but LM Studio has to load each model as its
            stage begins, which takes time and VRAM. Saving does not install or load anything.
            The storyboard&apos;s Load for planning button loads the planning model. AI planning
            must be enabled; OPENAI_VISION_MODEL stays separate.
          </p>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Save models
          </button>
        </form>
      ) : null}
      <AsyncStatus
        testId="planning-model-status"
        message={status}
        failed={failed}
        busy={busy || (!settings && !failed)}
      />
    </CollapsibleSection>
  );
}
