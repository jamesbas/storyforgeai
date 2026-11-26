"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SceneChecklist } from "@/components/scheduler/scene-checklist";
import {
  GENERATION_MODE_LABELS,
  RUN_TYPE_OPTIONS,
  runTypeAvailability,
  selectedScenesAvailability,
  type ProjectOption,
} from "@/components/scheduler/scheduler-rules";
import type { RunType, ScheduleItem, ScheduleOptions } from "@/lib/schemas/schedule";
import type { SchedulableScene } from "@/lib/services/scheduler-service";

export type ItemPayload = {
  projectId: string;
  runType: RunType;
  scope: { mode: "all" } | { mode: "selected"; sceneIds: string[] };
  options: ScheduleOptions;
};

/**
 * Add an item to the queue, or edit a waiting one.
 *
 * Editing keeps the project and run type: changing either is a different run,
 * and removing the item and adding the right one says so more plainly.
 */
export function ItemForm({
  projects,
  earlier,
  durableTasks,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  projects: readonly ProjectOption[];
  /** Items that would run before this one. */
  earlier: readonly ScheduleItem[];
  durableTasks: boolean;
  initial?: ScheduleItem;
  busy: boolean;
  onSubmit: (payload: ItemPayload) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const editing = Boolean(initial);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [chosenRunType, setRunType] = useState<RunType>(initial?.runType ?? "storyboard");
  const [chosenScope, setScopeMode] = useState<"all" | "selected">(initial?.scope.mode ?? "all");
  const [picked, setPicked] = useState<string[]>(
    initial?.scope.mode === "selected" ? initial.scope.sceneIds : [],
  );
  const [keyframes, setKeyframes] = useState<"missing" | "rerender">(initial?.options.keyframes ?? "missing");
  const [redoFinished, setRedoFinished] = useState(Boolean(initial?.options.redoFinished));
  const [sceneData, setSceneData] = useState<{ projectId: string; scenes: SchedulableScene[] } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? projects.filter((p) => p.title.toLowerCase().includes(needle)) : projects;
  }, [projects, query]);

  const runTypes = project ? runTypeAvailability(project, earlier, durableTasks) : null;
  const selectedScopes = project ? selectedScenesAvailability(project, earlier) : null;
  // Fall back to something allowed when the project changes underneath a choice.
  const runType: RunType =
    !editing && runTypes && !runTypes[chosenRunType].enabled ? "storyboard" : chosenRunType;
  const scopeMode = selectedScopes && !selectedScopes.enabled ? "all" : chosenScope;
  const mediaRun = runType === "keyframes" || runType === "video";
  const scenes = sceneData?.projectId === projectId ? sceneData.scenes : null;
  const wantScenes = Boolean(projectId) && mediaRun && scopeMode === "selected";

  useEffect(() => {
    if (!wantScenes) return;
    let live = true;
    void fetch(`/api/scheduler/projects?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { scenes: [] }))
      .then((body: { scenes?: SchedulableScene[] }) => {
        if (live) setSceneData({ projectId, scenes: body.scenes ?? [] });
      })
      .catch(() => {
        if (live) setSceneData({ projectId, scenes: [] });
      });
    return () => {
      live = false;
    };
  }, [projectId, wantScenes]);

  const payload = (): ItemPayload | null => {
    if (!project) return null;
    const scope: ItemPayload["scope"] =
      mediaRun && scopeMode === "selected" ? { mode: "selected", sceneIds: picked } : { mode: "all" };
    const options: ScheduleOptions =
      runType === "keyframes" ? (scope.mode === "all" ? { keyframes } : {}) : runType === "video" ? { redoFinished } : {};
    return { projectId: project.id, runType, scope, options };
  };

  const canSubmit =
    Boolean(project) &&
    Boolean(runTypes?.[runType].enabled) &&
    !(mediaRun && scopeMode === "selected" && picked.length === 0) &&
    !busy;

  const submit = async () => {
    const next = payload();
    if (!next) return;
    const ok = await onSubmit(next);
    if (ok && !editing) {
      setPicked([]);
      setScopeMode("all");
    }
  };

  const onAdd = () => {
    // FR-8: a storyboard run replaces the plans and the scene cards.
    if (!editing && runType === "storyboard" && project?.hasStoryboard) setConfirming(true);
    else void submit();
  };

  return (
    <form
      className="space-y-4"
      aria-label={editing ? "Edit item" : "Add item"}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onAdd();
      }}
    >
      {!editing && (
        <div className="space-y-2">
          <label htmlFor="scheduler-project" className="block text-sm font-medium">
            Project
          </label>
          <input
            type="search"
            aria-label="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            className="w-full max-w-sm rounded-md border border-white/10 bg-panel/40 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-accent focus:outline-none"
          />
          <select
            id="scheduler-project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setPicked([]);
            }}
            className="block w-full max-w-sm rounded-md border border-white/10 bg-panel/40 px-3 py-2 text-sm focus:border-accent focus:outline-none"
          >
            <option value="">Choose a project…</option>
            {filtered.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {GENERATION_MODE_LABELS[p.generationMode]}
              </option>
            ))}
          </select>
        </div>
      )}

      {project && runTypes && (
        <fieldset className="space-y-2" disabled={editing}>
          <legend className="text-sm font-medium">Run</legend>
          {RUN_TYPE_OPTIONS.map((option) => {
            const availability = runTypes[option.value];
            return (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scheduler-run-type"
                  value={option.value}
                  checked={runType === option.value}
                  disabled={!availability.enabled}
                  onChange={() => setRunType(option.value)}
                  className="mt-1"
                />
                <span>
                  {option.label}
                  {!availability.enabled && availability.reason && (
                    <span className="block text-xs text-slate-500">{availability.reason}</span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {project && mediaRun && selectedScopes && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Scenes</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="scheduler-scope"
              checked={scopeMode === "all"}
              onChange={() => setScopeMode("all")}
            />
            All scenes
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scheduler-scope"
              checked={scopeMode === "selected"}
              disabled={!selectedScopes.enabled}
              onChange={() => setScopeMode("selected")}
              className="mt-1"
            />
            <span>
              Selected scenes
              {!selectedScopes.enabled && selectedScopes.reason && (
                <span className="block text-xs text-slate-500">{selectedScopes.reason}</span>
              )}
            </span>
          </label>
          {scopeMode === "selected" &&
            (scenes ? (
              <SceneChecklist scenes={scenes} picked={picked} onChange={setPicked} />
            ) : (
              <p className="text-xs text-slate-500">Loading scenes…</p>
            ))}
        </fieldset>
      )}

      {project && runType === "keyframes" && scopeMode === "all" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Options</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="scheduler-keyframes"
              checked={keyframes === "missing"}
              onChange={() => setKeyframes("missing")}
            />
            Only scenes without keyframes
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="scheduler-keyframes"
              checked={keyframes === "rerender"}
              onChange={() => setKeyframes("rerender")}
            />
            Re-render every scene
          </label>
        </fieldset>
      )}

      {project && runType === "video" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Options</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={redoFinished}
              disabled={durableTasks}
              onChange={(event) => setRedoFinished(event.target.checked)}
              className="mt-1"
            />
            <span>
              Redo finished scenes
              <span className="block text-xs text-slate-500">
                {durableTasks
                  ? "Not available with durable tasks yet."
                  : "Rebuild clips that already exist, from their current keyframes. Off, finished scenes are skipped."}
              </span>
            </span>
          </label>
        </fieldset>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80 disabled:opacity-50"
        >
          {editing ? "Save changes" : "Add to queue"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Cancel
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Replace this project's storyboard?"
        confirmLabel="Add storyboard run"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void submit();
        }}
      >
        <p>
          {project?.title} already has a storyboard. When this item runs, the crew rewrites its plans and the
          Storyboard Artist replaces its scene cards.
        </p>
      </ConfirmDialog>
    </form>
  );
}
