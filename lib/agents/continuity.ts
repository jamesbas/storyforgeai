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
    "time, so a segment boundary is a technical join and never a cut. " +
    // "The size the previous segment's movement left the camera in" asked the
    // model to carry camera state across every entry of a single response. It
    // does not: a live 18-segment plan changed size at 12 of 17 seams, twice
    // going wider straight after a push-in. Writing both ends of each segment
    // makes the constraint local and checkable instead of remembered.
    "Write each sceneShotPlan as \"STARTS <size> \u2192 ENDS <size>\" before the lens, camera height, " +
    "movement and motivation \u2014 for example \"STARTS MWS \u2192 ENDS MCU, 35mm, eye level, slow push-in " +
    "as she decides\". The two may be the same when the camera holds. " +
    "The rule that matters: the size a segment ENDS on must be the size the next segment STARTS " +
    "on, exactly. Copy it across verbatim. Work forwards from segment 1 and carry the last size " +
    "you wrote into the next entry rather than choosing a fresh framing for each beat. " +
    // Chaining the seams alone just moved the contradiction inside the
    // segments: a live plan then produced "STARTS CU -> ENDS MWS, push-in"
    // twice, and swapped lens and camera height mid-take. The physics has to
    // be spelled out, because "carries across unchanged" was not enough.
    "Within a segment the movement and the size change must agree. A push-in ends tighter than it " +
    "starts and never wider. A pull-out ends wider and never tighter. Static, pan, tilt, tracking, " +
    "arc and handheld hold the size, or shift it by one step at most. If a segment needs a size " +
    "change, name the move that produces it. " +
    "One lens for the whole piece. You cannot change lens without stopping the camera, and the " +
    "camera never stops \u2014 so give the millimetres once, in lensAndFramingRules, and repeat that " +
    "same figure in every segment. Camera height may change, but only because the camera physically " +
    "travelled there: name the crane, boom, tilt or move that carried it. A static camera cannot " +
    "be at a different height from the segment before it. " +
    "Change framing only through movement inside a segment, or where the concept explicitly asks " +
    "for a cut. " +
    "Push-in, pull-out, orbit, arc, pan, tilt, tracking, crane and static are all available " +
    "inside a single continuous shot, and each still needs its motivation stated. " +
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
    // A character who is simply present in a start frame they were absent from
    // at the end of the previous segment has teleported, which reads as a cut in
    // a take that is not supposed to contain one.
    "Nobody appears between segments. A character who was not in the previous segment's end " +
    "frame is not in this segment's start frame either — they arrive during it. Write the start " +
    "frame without them, put their entrance in the action and the motion prompt, walking in, " +
    "leaning into shot, or revealed by the camera moving, and have the end frame show them " +
    "settled. Someone leaving works the same way in reverse. " +
    "Set transitionIn and transitionOut to \"Continuous\"."
  );
}
