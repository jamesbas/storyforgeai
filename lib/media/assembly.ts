import { finalCutPlanSchema, type FinalCutPlan } from "@/lib/schemas/assembly";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";

/** Pick the approved attempt for a scene, else the latest attempt. */
function chosenAttempt(record: ProjectRecord, sceneId: string): SceneAttempt | undefined {
  const attempts = record.attempts?.[sceneId] ?? [];
  return attempts.find((a) => a.approved) ?? attempts[attempts.length - 1];
}

/**
 * Build a final-cut plan from a storyboard's approved clips. The last scene's
 * duration already reflects `trimAtEndSeconds`, so the total equals the
 * requested runtime (spec Sections 2.2 / 17).
 */
export function buildFinalCutPlan(record: ProjectRecord): FinalCutPlan {
  if (!record.storyboard) throw new Error("No storyboard to assemble");

  const clips = record.storyboard.scenes.map((scene) => {
    const attempt = chosenAttempt(record, scene.id);
    if (!attempt?.videoPath) {
      throw new Error(`Scene ${scene.sceneNumber} has no generated video to assemble`);
    }
    return {
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      path: attempt.videoPath,
      durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
      transitionIn: scene.transitionIn,
      transitionOut: scene.transitionOut,
    };
  });

  const totalDurationSeconds = clips.reduce((sum, c) => sum + c.durationSeconds, 0);

  return finalCutPlanSchema.parse({
    projectId: record.project.id,
    clips,
    totalDurationSeconds,
    finalTrimSeconds: record.project.finalTrimSeconds,
  });
}
