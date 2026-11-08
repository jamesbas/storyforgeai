"use client";

import { useState } from "react";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import type { SceneChecksApi } from "@/components/storyboard/use-scene-checks";
import type { SceneCheckDepth } from "@/lib/schemas/scene-check";
import type { Scene } from "@/lib/schemas/storyboard";

export type CheckFirst = "off" | SceneCheckDepth;

/**
 * Check the scenes you pick — never the storyboard as a whole unless every
 * scene is ticked. Results land on each scene's card.
 */
export function SceneCheckTools({
  scenes,
  checks,
  defaultDepth = "quick",
  renderActive,
}: {
  scenes: readonly Scene[];
  checks: SceneChecksApi;
  defaultDepth?: SceneCheckDepth;
  /** A render batch is running, so a check would compete with it for the GPU. */
  renderActive?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [depth, setDepth] = useState<SceneCheckDepth>(defaultDepth);
  const progress = checks.data?.progress;
  const status = checks.data?.status ?? {};
  const running = progress?.entries.find((entry) => entry.state === "running");
  const withIssues = scenes.filter((scene) =>
    status[scene.id]?.quick === "issues" || status[scene.id]?.deep === "issues").map((scene) => scene.id);
  const stale = scenes.filter((scene) =>
    status[scene.id]?.quick === "out_of_date" || status[scene.id]?.deep === "out_of_date").map((scene) => scene.id);

  return (
    <details className="mt-3 rounded-md border border-white/10 bg-black/20" data-testid="scene-check-tools">
      <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
        Check selected scenes
        {progress?.active ? (
          <span className="ml-2 text-sky-300">
            {running ? `checking scene ${running.sceneNumber}` : "queued"} · {progress.remaining} left
          </span>
        ) : null}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-xs text-slate-500">
          Reviews the scenes you pick against their cards and the people in them, and reports what
          it can quote evidence for — a skin tone left out, an action dropped, a hand doing two
          things at once. <strong>Quick</strong> reads the prompts; <strong>Deep</strong> also reads
          the story beat, the scenes either side and the rendered keyframes. Nothing is changed:
          each finding offers a fix you can preview and apply, or accept as intentional.
        </p>
        {renderActive ? (
          <p className="text-[11px] text-amber-200/80">
            A render is running. Checks use the planning model on the same GPU, so they will slow it
            and may load the model back in mid-batch — better run when it finishes.
          </p>
        ) : null}
        <ScenePicker scenes={scenes} picked={picked} onChange={setPicked} testId="check-scene-picker" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {withIssues.length ? (
            <button
              type="button"
              onClick={() => setPicked(withIssues)}
              className="rounded-md border border-white/10 px-3 py-1.5 hover:border-accent"
            >
              Pick the {withIssues.length} with issues
            </button>
          ) : null}
          {stale.length ? (
            <button
              type="button"
              onClick={() => setPicked(stale)}
              className="rounded-md border border-white/10 px-3 py-1.5 hover:border-accent"
            >
              Pick the {stale.length} out of date
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {(["quick", "deep"] as const).map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-slate-300">
              <input
                type="radio"
                name="scene-check-depth"
                checked={depth === option}
                onChange={() => setDepth(option)}
              />
              {option === "quick" ? "Quick" : "Deep"}
            </label>
          ))}
          <button
            type="button"
            onClick={() => void checks.run(picked, depth)}
            disabled={picked.length === 0}
            data-testid="check-selected-scenes"
            className="rounded-md border border-white/10 px-3 py-1.5 hover:border-accent disabled:opacity-50"
          >
            Check {picked.length} scene{picked.length === 1 ? "" : "s"} ({depth})
          </button>
          {progress?.active ? (
            <button
              type="button"
              onClick={() => void checks.cancel()}
              className="rounded-md border border-white/10 px-3 py-1.5 text-slate-400 hover:border-white/25"
            >
              Cancel remaining
            </button>
          ) : null}
        </div>
        {checks.error ? <p className="text-xs text-red-300">{checks.error}</p> : null}
      </div>
    </details>
  );
}

/** "Check first" beside a rerun button: off renders as today. */
export function CheckFirstControl({
  value,
  onChange,
  testId,
}: {
  value: CheckFirst;
  onChange: (next: CheckFirst) => void;
  testId?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      Check first
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CheckFirst)}
        data-testid={testId}
        className="rounded border border-white/10 bg-canvas px-1.5 py-1 text-xs text-slate-200"
      >
        <option value="off">Off</option>
        <option value="quick">Quick</option>
        <option value="deep">Deep</option>
      </select>
    </label>
  );
}

/**
 * What a checked rerun did: how many scenes went to the render queue, and which
 * were held back and why, with the means to render them regardless.
 */
export function CheckedRerunNotice({
  checks,
  scenes,
  onRenderAnyway,
}: {
  checks: SceneChecksApi;
  scenes: readonly Scene[];
  onRenderAnyway: (scope: "keyframes" | "video", sceneIds: string[]) => void;
}) {
  const followUp = checks.data?.progress.followUp;
  if (!followUp) return null;
  const what = followUp.scope === "keyframes" ? "keyframes" : "clips";
  if (followUp.state === "waiting") {
    return (
      <p className="mt-3 rounded-md border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-sky-200/80" data-testid="checked-rerun-notice">
        Checking {followUp.sceneIds.length} scene{followUp.sceneIds.length === 1 ? "" : "s"} ({followUp.depth}) before
        rendering their {what}. Scenes with an error will be held back.
      </p>
    );
  }
  if (followUp.state === "cancelled") return null;
  if (followUp.state === "failed") {
    return (
      <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200" data-testid="checked-rerun-notice">
        The checks finished but the {what} could not be queued: {followUp.error}
      </p>
    );
  }
  const held = followUp.held ?? [];
  const numberOf = (sceneId: string) => scenes.find((scene) => scene.id === sceneId)?.sceneNumber;
  return (
    <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100/90" data-testid="checked-rerun-notice">
      <p>
        Checked first ({followUp.depth}): {followUp.queued ?? 0} scene{followUp.queued === 1 ? "" : "s"} queued for{" "}
        {what}
        {held.length ? `, ${held.length} held back.` : "."}
      </p>
      {held.length ? (
        <>
          <ul className="mt-1 space-y-0.5">
            {held.map((scene) => (
              <li key={scene.sceneId}>
                <a href={`#scene-${scene.sceneId}`} className="underline decoration-dotted">
                  Scene {numberOf(scene.sceneId) ?? scene.sceneNumber}
                </a>
                : {scene.reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onRenderAnyway(followUp.scope, held.map((scene) => scene.sceneId))}
            className="mt-2 rounded-md border border-white/15 px-3 py-1.5 hover:border-accent"
          >
            Render the held scene{held.length === 1 ? "" : "s"} anyway
          </button>
        </>
      ) : null}
    </div>
  );
}
