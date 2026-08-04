import type { PhaseProgress, SceneQueueEntry } from "@/lib/services/scene-queue";

export type BatchPhase = PhaseProgress["phase"];

/** What each phase is actually doing, in the user's terms rather than the code's. */
const PHASE_LABELS: Record<BatchPhase, string> = {
  keyframes: "Rendering keyframes",
  face_swap: "Applying face swap",
  video: "Rendering clips",
  qc: "Scoring results",
};

/** The same phases as they read on a single scene's chip. */
const SCENE_PHASE_RUNNING: Record<BatchPhase, string> = {
  keyframes: "rendering keyframes",
  face_swap: "swapping face",
  video: "rendering clip",
  qc: "scoring",
};

const SCENE_PHASE_DONE: Record<BatchPhase, string> = {
  keyframes: "keyframes done",
  face_swap: "face swapped",
  video: "clip done",
  qc: "scored",
};

/**
 * The clip phase still runs in a keyframes-only project — it closes the attempts
 * out — but it renders nothing, so announcing it as clips is a plain untruth.
 */
export function phaseLabel(phase: BatchPhase, rendersVideo: boolean): string {
  return phase === "video" && !rendersVideo ? "Finishing scenes" : PHASE_LABELS[phase];
}

export function scenePhaseLabel(phase: BatchPhase, rendersVideo: boolean): string {
  return phase === "video" && !rendersVideo ? "finishing" : SCENE_PHASE_RUNNING[phase];
}

/**
 * What one chip says.
 *
 * A phased batch marks every scene running at once, so the lifecycle state alone
 * leaves twenty-four chips reading "running" for the hours before the first clip
 * lands. The phase is what distinguishes them.
 */
export function chipLabel(entry: SceneQueueEntry, rendersVideo: boolean): string {
  if (entry.state !== "running") return entry.state;
  if (entry.phase) return scenePhaseLabel(entry.phase, rendersVideo);
  if (entry.completedPhase) return SCENE_PHASE_DONE[entry.completedPhase];
  return "running";
}
