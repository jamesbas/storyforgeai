"use client";

import type { SchedulableScene } from "@/lib/services/scheduler-service";

/**
 * Pick scenes for a scheduled run, seeing what each already has.
 *
 * The badges are what make the shortcuts worth having: "everything without a
 * clip" is the usual overnight question, and answering it by eye on a
 * twenty-four scene project is how scenes get missed.
 */
export function SceneChecklist({
  scenes,
  picked,
  onChange,
}: {
  scenes: readonly SchedulableScene[];
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const pick = (ids: string[]) => onChange(ids);
  const shortcuts: { label: string; ids: string[] }[] = [
    { label: "Select all", ids: scenes.map((s) => s.id) },
    { label: "Select none", ids: [] },
    { label: "Select scenes without keyframes", ids: scenes.filter((s) => !s.hasKeyframes).map((s) => s.id) },
    { label: "Select scenes without clips", ids: scenes.filter((s) => !s.hasClip).map((s) => s.id) },
  ];

  return (
    <fieldset className="space-y-2" data-testid="scene-checklist">
      <legend className="sr-only">Scenes to run</legend>
      <div className="flex flex-wrap gap-2">
        {shortcuts.map((shortcut) => (
          <button
            key={shortcut.label}
            type="button"
            onClick={() => pick(shortcut.ids)}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent"
          >
            {shortcut.label}
          </button>
        ))}
      </div>
      <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-white/10 p-2">
        {scenes.map((scene) => (
          <li key={scene.id}>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={picked.includes(scene.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...picked, scene.id] : picked.filter((id) => id !== scene.id))
                }
              />
              <span className="font-medium text-slate-200">Scene {scene.sceneNumber}</span>
              <span className="truncate">{scene.title}</span>
              {scene.hasKeyframes && (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">has keyframes</span>
              )}
              {scene.hasClip && (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">has clip</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        {picked.length} of {scenes.length} picked
      </p>
    </fieldset>
  );
}
