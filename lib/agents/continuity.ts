import { DEFAULT_SCENE_CONTINUITY } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";

/**
 * Tell the planning agents whether the segments are one continuous take.
 *
 * A segment boundary here is a technical join: the video model renders about
 * twenty seconds at a time, so a sixty-second piece is cut into three jobs. The
 * agents were treating each of those joins as an invitation to cut to a new
 * shot, which produced a three-shot edit nobody asked for — and under
 * `reuse_end_frame` the renderer then reused the frame across it anyway.
 *
 * `sceneContinuity` is the user's statement of intent and was already on the
 * project; nothing in any system prompt had ever read it.
 */
export function isContinuousTake(project: Project): boolean {
  return (project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) !== "cut";
}

/** Camera guidance for the Cinematographer, keyed on how the segments join. */
export function cameraContinuityDirective(project: Project): string {
  if (!isContinuousTake(project)) {
    return (
      " The segments of this project are separate shots, cut together. Vary sizes deliberately " +
      "across the storyboard — contrast between shot sizes is what signals which moments matter, " +
      "and a run of identical framings has no emphasis. Establish a new location on a wider size " +
      "before moving in."
    );
  }
  return (
    ` The segments of this project are one continuous take, not separate shots. They are split ` +
    `at ${project.segmentSeconds} seconds only because the video model renders that much at a ` +
    "time, so a segment boundary is a technical join and never a cut. Do not change framing at a " +
    "boundary: the shot size you name for a segment must be the size the previous segment's " +
    "camera movement left the camera in, and the lens and camera height carry across unchanged. " +
    "Change the shot size only where the concept explicitly asks for a cut. " +
    "Get your variety from movement instead of from cutting — push-in, pull-out, orbit, arc, " +
    "pan, tilt, tracking, crane and static are all available inside a single continuous shot, " +
    "and each still needs its motivation stated. A push-in that ends tight is how the piece " +
    "reaches a close-up; cutting to one is not available to you. " +
    "Set every transition to \"Continuous\"."
  );
}

/**
 * Seam guidance for the Storyboard and Image Prompt agents.
 *
 * Under a continuous take the next scene's start frame is literally the
 * previous scene's end frame — the same file — so a start-frame prompt that
 * opens a new framing describes an image that will never exist.
 */
export function seamDirective(project: Project): string {
  if (!isContinuousTake(project)) return "";
  return (
    " The segments of this project are one continuous take, split only because the video model " +
    `renders about ${project.segmentSeconds} seconds at a time. A segment boundary is not a cut. ` +
    "When a previous end frame is supplied, this scene's start frame is that exact image, so " +
    "your start-frame prompt must describe it: the same shot size, camera height, lens, camera " +
    "position and subject placement, with the subject mid-action rather than reset to a new " +
    "pose. Never open a segment on a new framing. " +
    "The camera may move within the segment, so the end frame may be tighter or wider than the " +
    "start — that movement is where the visual variety comes from, and the next segment picks " +
    "the camera up wherever this one leaves it. " +
    "Set transitionIn and transitionOut to \"Continuous\"."
  );
}
