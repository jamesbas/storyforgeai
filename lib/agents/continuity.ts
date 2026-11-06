import { DEFAULT_SCENE_CONTINUITY, generationStages } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";
import type { Scene } from "@/lib/schemas/storyboard";
import { config } from "@/lib/config";
import { seamBreak } from "@/lib/media/seam";

/** Shared by prompt authorship and rendering; a scene may only opt out. */
export function referencesCarriedFrame(project: Project, sceneId: string, inherited: boolean): boolean {
  return inherited &&
    config.media.endFrameReferencesStartFrame &&
    project.endFrameReferences !== false &&
    project.sceneEndFrameRefs?.[sceneId] !== false;
}

/**
 * Whether this scene's closing frame is written and rendered as an edit of a
 * source frame — the frame carried in from the previous scene, or, where
 * nothing is carried (scene 1, or the scene after a real cut), this scene's own
 * opening frame.
 *
 * Only under `reuse_end_frame`, the one mode whose settings offer the opt-out.
 */
export function editsEndFrame(project: Project, sceneId: string): boolean {
  return (project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) === "reuse_end_frame" &&
    referencesCarriedFrame(project, sceneId, true);
}

/**
 * Carry a changed closing-frame prompt into the opening of the scene after it.
 *
 * Under `reuse_end_frame` the next scene opens on this scene's end frame, so its
 * start prompt has to describe that same picture. It was kept in step only when
 * the prompts were written together: a hand edit, a bulk prompt tool, or a
 * rewrite of one scene left the next scene's opening describing the old ending
 * and had to be copied across by hand.
 *
 * Only where the next scene was going to open on this frame — its opening is
 * a copy of the old ending, or the seam between them continues — and only
 * when the same change did not set that opening itself. A planned cut keeps
 * the opening it was written with.
 */
export function carryEndFramesForward(
  project: Project,
  before: readonly Scene[],
  after: readonly Scene[],
): { scenes: Scene[]; carried: string[] } {
  if ((project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) !== "reuse_end_frame") {
    return { scenes: [...after], carried: [] };
  }
  const options = { clipCarriesArrivals: generationStages(project.generationMode).video };
  const old = new Map(before.map((scene) => [scene.id, scene] as const));
  const scenes = [...after];
  const order = scenes
    .map((scene, index) => ({ scene, index }))
    .sort((a, b) => a.scene.sceneNumber - b.scene.sceneNumber);
  const carried: string[] = [];
  for (let i = 0; i + 1 < order.length; i += 1) {
    const current = scenes[order[i]!.index]!;
    const nextIndex = order[i + 1]!.index;
    const next = scenes[nextIndex]!;
    if (next.sceneNumber !== current.sceneNumber + 1) continue;
    const wasCurrent = old.get(current.id);
    const wasNext = old.get(next.id);
    if (!wasCurrent || !wasNext) continue;
    const newEnd = current.prompts.endFramePrompt;
    if (newEnd === wasCurrent.prompts.endFramePrompt) continue;
    if (next.prompts.startFramePrompt !== wasNext.prompts.startFramePrompt) continue;
    const opensOnIt = wasNext.prompts.startFramePrompt === wasCurrent.prompts.endFramePrompt ||
      !seamBreak(wasCurrent, wasNext, options);
    if (!opensOnIt || next.prompts.startFramePrompt === newEnd) continue;
    scenes[nextIndex] = { ...next, prompts: { ...next.prompts, startFramePrompt: newEnd } };
    carried.push(next.id);
  }
  return { scenes, carried };
}

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
