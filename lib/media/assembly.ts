import { finalCutPlanSchema, type FinalCutPlan } from "@/lib/schemas/assembly";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { PrerequisiteError } from "@/lib/errors";

/** Why a scene cannot enter the final cut. */
export type MissingApprovalReason =
  | "no_attempt"
  | "no_approved_attempt"
  | "approved_attempt_missing_video";

export type MissingApproval = {
  sceneId: string;
  sceneNumber: number;
  sceneTitle: string;
  reason: MissingApprovalReason;
};

export type AssemblyReadiness = {
  ready: boolean;
  totalScenes: number;
  approvedScenes: number;
  missingApprovals: MissingApproval[];
};

export const ASSEMBLY_PREREQUISITE_MESSAGE =
  "Every scene needs an approved video before assembly.";

/**
 * The attempt a scene may be cut from.
 *
 * Assembly is stricter than display: there is no "approved else latest"
 * fallback here, because an unreviewed or rejected take must never reach the
 * final cut. A newer attempt never displaces an older approved one.
 */
export function selectApprovedAttempt(
  record: ProjectRecord,
  sceneId: string,
): { attempt?: SceneAttempt; reason?: MissingApprovalReason } {
  const attempts = record.attempts?.[sceneId] ?? [];
  if (!attempts.length) return { reason: "no_attempt" };

  const approved = attempts.filter((a) => a.approved);
  if (!approved.length) return { reason: "no_approved_attempt" };

  const usable = approved.find((a) => (a.videoPath ?? "").trim().length > 0);
  if (!usable) return { reason: "approved_attempt_missing_video" };

  return { attempt: usable };
}

/** Every scene that blocks assembly, in scene order. */
export function assemblyPrerequisites(record: ProjectRecord): MissingApproval[] {
  const missing: MissingApproval[] = [];
  for (const scene of record.storyboard?.scenes ?? []) {
    const { reason } = selectApprovedAttempt(record, scene.id);
    if (reason) {
      missing.push({
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        sceneTitle: scene.title,
        reason,
      });
    }
  }
  return missing;
}

/** Approval state for the assembly screen; pure, so the client may call it. */
export function assemblyReadiness(record: ProjectRecord): AssemblyReadiness {
  const totalScenes = record.storyboard?.scenes.length ?? 0;
  const missingApprovals = assemblyPrerequisites(record);
  return {
    ready: totalScenes > 0 && missingApprovals.length === 0,
    totalScenes,
    approvedScenes: totalScenes - missingApprovals.length,
    missingApprovals,
  };
}

export function assemblyPrerequisiteError(missing: MissingApproval[]): PrerequisiteError {
  return new PrerequisiteError(ASSEMBLY_PREREQUISITE_MESSAGE, { missingApprovals: missing });
}

/**
 * Build a final-cut plan from a storyboard's approved clips. The last scene's
 * duration already reflects `trimAtEndSeconds`, so the total equals the
 * requested runtime (spec Sections 2.2 / 17).
 */
export function buildFinalCutPlan(record: ProjectRecord): FinalCutPlan {
  if (!record.storyboard) throw new Error("No storyboard to assemble");

  const missing = assemblyPrerequisites(record);
  if (missing.length) throw assemblyPrerequisiteError(missing);

  const clips = record.storyboard.scenes.map((scene) => {
    const { attempt } = selectApprovedAttempt(record, scene.id);
    if (!attempt?.videoPath) {
      throw assemblyPrerequisiteError([
        {
          sceneId: scene.id,
          sceneNumber: scene.sceneNumber,
          sceneTitle: scene.title,
          reason: "no_approved_attempt",
        },
      ]);
    }
    return {
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      attemptId: attempt.id,
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
