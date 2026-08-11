"use client";

import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Pick scenes to act on, with the means to take or drop the lot.
 *
 * Shared by the clip queue and the prompt rewrite because the alternative to a
 * selection is the all-scenes button, and reaching for that to fix five scenes
 * discards the hand edits on the other thirteen.
 */
export function ScenePicker({
  scenes,
  picked,
  onChange,
  testId,
}: {
  scenes: readonly Scene[];
  picked: readonly string[];
  onChange: (next: string[]) => void;
  testId?: string;
}) {
  const all = scenes.map((scene) => scene.id);
  return (
    <div className="space-y-2" data-testid={testId}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {scenes.map((scene) => (
          <li key={scene.id}>
            <label className="flex items-center gap-1.5 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={picked.includes(scene.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...picked, scene.id]
                      : picked.filter((id) => id !== scene.id),
                  )
                }
              />
              Scene {scene.sceneNumber}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(all)}
          disabled={picked.length === scenes.length}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={picked.length === 0}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}
