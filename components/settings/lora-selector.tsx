"use client";

import { useCallback, useEffect, useState } from "react";
import { MAX_LORAS_PER_MODEL } from "@/lib/schemas/lora";
import type { LoraCatalog, LoraKind, LoraSelection } from "@/lib/schemas/lora";

/**
 * LoRA picker for one model kind.
 *
 * Selection order is preserved because WanGP matches `loras_multipliers` to
 * `activated_loras` by index — reordering the list silently reassigns weights.
 */
export function LoraSelector({
  projectId,
  kind,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  kind: LoraKind;
  value: LoraSelection[];
  onChange: (next: LoraSelection[]) => void;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<LoraCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/wangp/loras?projectId=${encodeURIComponent(projectId)}&kind=${kind}` +
            (refresh ? "&refresh=1" : ""),
          { cache: "no-store" },
        );
        setCatalog(
          res.ok
            ? ((await res.json()) as LoraCatalog)
            : { supported: false, modelType: "", reason: "Could not reach the LoRA catalog." },
        );
      } catch {
        setCatalog({ supported: false, modelType: "", reason: "Could not reach the LoRA catalog." });
      } finally {
        setLoading(false);
      }
    },
    [projectId, kind],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-xs text-slate-500">Loading {kind} LoRAs…</p>;

  if (!catalog?.supported) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-slate-500">{catalog?.reason ?? "No LoRA catalog available."}</p>
        <RefreshButton onClick={() => void load(true)} />
      </div>
    );
  }

  const chosen = new Set(value.map((v) => v.name));
  const available = catalog.loras.filter((entry) => !chosen.has(entry.name));
  const atLimit = value.length >= MAX_LORAS_PER_MODEL;

  const add = (name: string) => {
    if (!name || atLimit) return;
    onChange([...value, { name, strength: 1 }]);
  };
  const remove = (name: string) => onChange(value.filter((v) => v.name !== name));
  const setStrength = (name: string, strength: number) =>
    onChange(value.map((v) => (v.name === name ? { ...v, strength } : v)));

  return (
    <div className="space-y-2">
      {value.length ? (
        <ul className="space-y-1">
          {value.map((selection) => {
            const entry = catalog.loras.find((l) => l.name === selection.name);
            return (
              <li
                key={selection.name}
                className="flex items-start gap-2 rounded-md border border-white/10 bg-canvas/60 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-slate-200">{entry?.label ?? selection.name}</p>
                  <p className="truncate text-[10px] text-slate-500">{selection.name}</p>
                  {entry?.triggerWords.length ? (
                    <p className="truncate text-[10px] text-amber-300/80">
                      Trigger: {entry.triggerWords.join(", ")}
                    </p>
                  ) : null}
                </div>
                <label className="flex items-center gap-1 text-[10px] text-slate-400">
                  <span>Strength</span>
                  <input
                    type="number"
                    step={0.05}
                    min={-10}
                    max={10}
                    disabled={disabled}
                    value={selection.strength}
                    onChange={(e) => setStrength(selection.name, Number(e.target.value))}
                    className="w-16 rounded border border-white/10 bg-panel/60 px-1.5 py-1 text-right text-xs"
                  />
                </label>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(selection.name)}
                  className="rounded px-1.5 py-1 text-xs text-slate-400 hover:text-red-300"
                  aria-label={`Remove ${selection.name}`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">No LoRAs selected.</p>
      )}

      <div className="flex items-center gap-2">
        <select
          disabled={disabled || atLimit || available.length === 0}
          value=""
          onChange={(e) => add(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel/60 px-2 py-1.5 text-xs"
        >
          <option value="">
            {atLimit
              ? `Limit of ${MAX_LORAS_PER_MODEL} reached`
              : available.length
                ? `Add a LoRA (${available.length} available)`
                : "No more LoRAs installed for this model"}
          </option>
          {available.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.label}
              {entry.label !== entry.name ? ` — ${entry.name}` : ""}
              {entry.sizeMb ? ` (${entry.sizeMb} MB)` : ""}
            </option>
          ))}
        </select>
        <RefreshButton onClick={() => void load(true)} />
      </div>

      <p className="text-[10px] text-slate-600">
        Reading {catalog.loras.length} LoRA{catalog.loras.length === 1 ? "" : "s"} from{" "}
        <code>loras/{catalog.directory}</code> for {catalog.modelType}.
      </p>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-md border border-white/10 px-2 py-1.5 text-[11px] text-slate-400 hover:text-slate-200"
    >
      Refresh
    </button>
  );
}
