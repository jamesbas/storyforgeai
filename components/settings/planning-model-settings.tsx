"use client";

import { useCallback, useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import {
  PLANNING_MODELS,
  type PlanningModelSettingsView,
} from "@/lib/schemas/planning-model-settings";

export function PlanningModelSettingsForm() {
  const [settings, setSettings] = useState<PlanningModelSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>("Loading planning model...");

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings/planning-model", { cache: "no-store" });
      const body = (await res.json()) as { settings: PlanningModelSettingsView; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not load planning model settings.");
      if (!isCurrent()) return;
      setSettings(body.settings);
      setStatus(null);
    } catch (error) {
      if (!isCurrent()) return;
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not load planning model settings.");
    }
  }, []);

  useLoadEffect(load);

  const save = async (model: string | null) => {
    setBusy(true);
    setFailed(false);
    setStatus("Saving...");
    try {
      const res = await fetch("/api/settings/planning-model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = (await res.json()) as { settings: PlanningModelSettingsView; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save planning model settings.");
      setSettings(body.settings);
      setStatus(`Saved. Future AI planning calls will use ${body.settings.effectiveModel}.`);
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not save planning model settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollapsibleSection
      testId="planning-model-section"
      title="AI planning model"
      description="Choose the text model for future AI planning calls in every project. Saved across restarts without editing .env.local. Existing artifacts and in-flight requests are unchanged."
    >
      {settings ? (
        <>
          <label htmlFor="planning-model" className="block text-sm font-medium">
            Planning model
          </label>
          <select
            id="planning-model"
            className="w-full rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
            value={settings.model ?? ""}
            disabled={busy}
            aria-describedby="planning-model-help"
            onChange={(event) => void save(event.target.value || null)}
          >
            <option value="">Use environment default ({settings.defaultModel})</option>
            {PLANNING_MODELS.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
          <p id="planning-model-help" className="text-xs text-slate-400">
            The default comes from OPENAI_MODEL (gpt-4o-mini when unset). These are model
            presets, not an installed-model check. The selected model must be available on
            your configured OpenAI-compatible server; changing it does not install or load
            weights. The storyboard&apos;s Load for planning button uses this choice. AI
            planning must be enabled; OPENAI_VISION_MODEL stays separate.
          </p>
        </>
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
