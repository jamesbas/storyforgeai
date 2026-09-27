"use client";

import { useState } from "react";
import { ClimaxFields } from "@/components/shared/climax-fields";
import { MAX_CLIMAX_CHARACTERS } from "@/lib/types";

/**
 * The climax fields as a saved setting.
 *
 * Saved on a button rather than on every keystroke: the climax is a sentence,
 * and each save of a half-typed one would mark the arc out of date for a
 * climax nobody asked for.
 */
export function ClimaxSettings({
  climax: initialClimax,
  aftermath: initialAftermath,
  segmentCount,
  hasArc,
  busy,
  onSave,
}: {
  climax: string;
  aftermath: number | undefined;
  segmentCount: number;
  hasArc: boolean;
  busy: boolean;
  onSave: (climax: string, aftermath: number | undefined) => void | Promise<void>;
}) {
  const [climax, setClimax] = useState(initialClimax);
  const [aftermath, setAftermath] = useState(initialAftermath);
  const changed = climax.trim() !== initialClimax.trim() || aftermath !== initialAftermath;
  const tooLong = climax.length > MAX_CLIMAX_CHARACTERS;

  return (
    <section
      className="space-y-3 rounded-lg border border-white/10 bg-panel/40 p-4"
      data-testid="climax-settings"
    >
      <h2 className="font-semibold">Story climax</h2>
      <ClimaxFields
        climax={climax}
        aftermath={aftermath}
        segmentCount={segmentCount}
        onClimaxChange={setClimax}
        onAftermathChange={setAftermath}
        disabled={busy}
        field="rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm outline-none focus:border-accent"
        label="block text-sm text-slate-300"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void onSave(climax, aftermath)}
          disabled={busy || !changed || tooLong}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          Save climax
        </button>
        {hasArc ? (
          <span className="text-[11px] text-slate-500">
            The arc is already written. Changing this marks it out of date on the Agentic Canvas,
            and it takes effect when you regenerate the Story Architect.
          </span>
        ) : null}
      </div>
    </section>
  );
}
