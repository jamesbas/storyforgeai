import { randomUUID } from "node:crypto";
import type { Project } from "@/lib/schemas/project";
import type { InsertSceneCard } from "@/lib/schemas/storyboard";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * Adding a scene to a storyboard that already exists.
 *
 * The position, numbering and clock all belong to
 * `lib/storyboard/running-order.ts`; what lives here is the one question
 * insertion asks that reordering does not — what a brand-new scene is made of.
 */

/**
 * An id that owes nothing to the scene's position.
 *
 * The generators mint `${projectId}-scene-007` from the scene number, and the
 * coincidence is load-bearing in the wrong direction: nine structures are keyed
 * by scene id, so if renumbering also renamed, an insertion would orphan every
 * rendered frame after it. The `-x-` shape is deliberately one the generators
 * can never produce, so an inserted scene cannot collide with a later
 * regeneration either.
 */
export function mintSceneId(projectId: string): string {
  return `${projectId}-scene-x-${randomUUID().slice(0, 8)}`;
}

/**
 * The scene a creator just described, as a draft the prompt agents can read.
 *
 * Timing is left at the values for the end of the board and corrected by
 * `applyRunningOrder` the moment the running order is applied; writing them
 * here as well would be two sources for one fact.
 */
export function newSceneDraft(project: Project, card: InsertSceneCard, id: string): SceneDraft {
  return {
    id,
    projectId: project.id,
    // Placeholders. Position owns all four, and owns them within the same call.
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: project.segmentSeconds,
    targetDurationSeconds: project.segmentSeconds,
    title: card.title,
    sceneObjective: card.sceneObjective ?? "",
    storyBeat: card.storyBeat ?? "",
    visualDescription: card.visualDescription,
    actionDescription: card.actionDescription,
    cameraMovement: card.cameraMovement ?? "",
    // `seamBreak` reads `transitionIn`, so this is how a creator declares that
    // the new scene is a cut and should not inherit its neighbour's last frame.
    transitionIn: card.transitionIn ?? "",
    transitionOut: card.transitionOut ?? "",
    continuityNotes: [],
    subjectFaceVisible: true,
    // Left empty on purpose: `charactersInScene` reads the card text, so a cast
    // named in the visual or action description is found without being listed,
    // and a list invented here would outrank what the creator actually wrote.
    charactersPresent: [],
    wardrobeChanges: [],
    ...(card.dialogue?.length ? { dialogue: card.dialogue } : {}),
    status: "planned",
  };
}
