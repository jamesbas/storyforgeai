import { createHash } from "node:crypto";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { proposeSceneFeedback, feedbackPatch } from "@/lib/agents/scene-feedback";
import { buildSceneCheckInput, sceneCheckSources } from "@/lib/agents/scene-check";
import { framePromptBody } from "@/lib/agents/scene-cast";
import { rebuiltPrompts } from "@/lib/agents/cast-sheet";
import { carryEndFramesForward } from "@/lib/agents/continuity";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import { imagePromptDirective, videoPromptDirective, hasNativeAudio } from "@/lib/agents/model-directives";
import { storedPromptWarnings, storedSceneImageContext } from "@/lib/agents/prompt-validation";
import { config } from "@/lib/config";
import { NotFoundError, PrerequisiteError, ValidationError } from "@/lib/errors";
import {
  sceneFeedbackApplySchema,
  sceneFeedbackRequestSchema,
  type SceneFeedbackPreview,
  type SceneFeedbackProposal,
  type SceneFeedbackScope,
} from "@/lib/schemas/scene-feedback";
import { applyScenePromptsPatch, scenePromptsPatchSchema, type ProjectRecord, type Scene } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { getAgentRun, trackAgentRun } from "@/lib/services/agent-runs";
import { resolveProjectCast } from "@/lib/services/character-service";
import { getProjectRecord, updateScenePrompts } from "@/lib/services/project-service";
import { getQueue } from "@/lib/services/scene-queue";
import { getSceneCheckProgress } from "@/lib/services/scene-check-service";
import { activeTask } from "@/lib/tasks/task-service";
import { logEvent } from "@/lib/telemetry";
import { familyOf } from "@/lib/wangp/family";

async function assertIdle(projectId: string): Promise<void> {
  if (getAgentRun(projectId) || getQueue(projectId).active || getSceneCheckProgress(projectId).active ||
    (config.flags.durableTasks && await activeTask(projectId))) {
    throw new PrerequisiteError("Wait for the current generation, planning run or scene check to finish before refining prompts.");
  }
}

function sourceHash(record: ProjectRecord, sceneId: string, cast: readonly Character[]): string {
  return createHash("sha256").update(JSON.stringify({
    sceneId,
    project: record.project,
    storyboard: record.storyboard,
    storyPlan: record.storyPlan,
    directorialPlan: record.directorialPlan,
    cinematographyPlan: record.cinematographyPlan,
    cast,
    models: [record.project.imageModel || config.wangp.imageModel, record.project.videoModel || config.wangp.videoModel],
  })).digest("hex");
}

function sceneContext(record: ProjectRecord, sceneId: string, cast: readonly Character[]) {
  const sources = sceneCheckSources(record, sceneId, cast);
  if (!sources) throw new NotFoundError(`Scene ${sceneId} not found`);
  // This workflow is deliberately text-only: user observations, not another visual review.
  const { frames: _frames, ...input } = buildSceneCheckInput(sources, "deep");
  return { sources, input };
}

function preparedFeedback(
  record: ProjectRecord,
  sceneId: string,
  cast: readonly Character[],
  scope: SceneFeedbackScope,
  proposal: SceneFeedbackProposal,
): { patch: ReturnType<typeof feedbackPatch>; preview: SceneFeedbackPreview } {
  const { sources, input } = sceneContext(record, sceneId, cast);
  const { scene, project, scenes, visualBible } = sources;
  const patch = feedbackPatch(scene, scope, proposal, input.generation.rendersVideo);
  const candidate: Scene = { ...scene, prompts: applyScenePromptsPatch(scene.prompts, patch) };
  const wardrobe = wardrobeTimeline(project, scenes, cast, visualBible).get(scene.id);
  const composed = rebuiltPrompts(candidate, cast, wardrobe, visualBible);
  for (const field of ["startFramePrompt", "endFramePrompt", "videoPromptSegment"] as const) {
    if (patch[field] !== undefined) patch[field] = composed[field];
  }
  scenePromptsPatchSchema.parse(patch);
  const revised = { ...scene, prompts: applyScenePromptsPatch(scene.prompts, patch) };
  const videoChanged = (["videoPromptSegment", "videoSoundscape", "videoScore"] as const)
    .some((field) => revised.prompts[field] !== scene.prompts[field]);
  if (videoChanged !== proposal.videoReview.needsChange) {
    throw new ValidationError("The video-impact explanation does not match the final composed prompts. Preview again.");
  }
  const changes: SceneFeedbackPreview["changes"] = proposal.revisions.flatMap((revision) => {
    const before = scene.prompts[revision.field] ?? "";
    const after = revised.prompts[revision.field] ?? "";
    return before === after ? [] : [{
      sceneId, sceneNumber: scene.sceneNumber, field: revision.field, before, after, reason: revision.reason,
    }];
  });
  if (!changes.some((change) => scope === "video"
    ? change.field.startsWith("video")
    : change.field === "startFramePrompt" || change.field === "endFramePrompt")) {
    throw new ValidationError("The proposal leaves the chosen prompts unchanged after continuity is restored. Clarify the feedback and preview again.");
  }
  const { scenes: carriedScenes, carried } = carryEndFramesForward(
    project, scenes, scenes.map((s) => s.id === sceneId ? revised : s),
  );
  for (const id of carried) {
    const before = scenes.find((s) => s.id === id)!;
    const after = carriedScenes.find((s) => s.id === id)!;
    changes.push({
      sceneId: id, sceneNumber: after.sceneNumber, field: "startFramePrompt",
      before: before.prompts.startFramePrompt, after: after.prompts.startFramePrompt,
      reason: `This opening follows scene ${scene.sceneNumber}'s revised end frame.`,
      carried: true,
    });
  }
  const warnings: string[] = [];
  for (const id of carried) {
    const next = carriedScenes.find((s) => s.id === id)!;
    warnings.push(`Scene ${next.sceneNumber}'s opening will follow this ending, but its other prompts are not rewritten. Review that scene's end-frame edit and motion before regenerating it.`);
  }
  for (const after of carriedScenes.filter((s) => s.id === sceneId || carried.includes(s.id))) {
    const before = scenes.find((s) => s.id === after.id)!;
    const context = storedSceneImageContext(project, after, cast, visualBible, carriedScenes);
    const existing = new Set(storedPromptWarnings(before, storedSceneImageContext(project, before, cast, visualBible, scenes)));
    warnings.push(...storedPromptWarnings(after, context).filter((warning) => !existing.has(warning))
      .map((warning) => `Scene ${after.sceneNumber}: ${warning}`));
  }
  if (patch.startFramePrompt !== undefined && patch.startFramePrompt !== scene.prompts.startFramePrompt) {
    if (input.generation.opensOnPreviousFrame) {
      warnings.push("This opening can reuse the previous scene's rendered end frame. A prompt edit cannot change that image: revise/regenerate the preceding end frame or import a replacement opening before rendering the clip.");
    }
    if (scene.sceneNumber === 1 && project.openingFrame) {
      warnings.push("Scene 1 uses a pinned opening image. Changing its prompt does not replace that image; unpin it or supply a replacement to change the opening.");
    }
  }
  return {
    patch,
    preview: { sceneId, scope, sourceHash: sourceHash(record, sceneId, cast), proposal, changes, warnings },
  };
}

/** Nothing is persisted until the person accepts the complete, coordinated proposal. */
export async function previewSceneFeedback(projectId: string, sceneId: string, raw: unknown): Promise<SceneFeedbackPreview> {
  const request = sceneFeedbackRequestSchema.parse(raw);
  await assertIdle(projectId);
  const provider = getPlanningProvider();
  if (!provider) {
    throw new PrerequisiteError("Feedback refinement requires AI planning and a configured planning model. Configure the LLM connection first.");
  }
  // Reserve the project before the first read/model call; a second feedback request must wait.
  if (getAgentRun(projectId)) throw new PrerequisiteError("A planning run is already in progress.");
  return trackAgentRun(projectId, "scene_feedback", "Scene feedback", async () => {
    const record = await getProjectRecord(projectId);
    const cast = await resolveProjectCast(record.project);
    const { sources, input } = sceneContext(record, sceneId, cast);
    if (request.scope === "video" && !input.generation.rendersVideo) {
      throw new ValidationError("This scene has no active video prompt to refine.");
    }
    const imageFamily = familyOf(record.project.imageModel || config.wangp.imageModel);
    const videoFamily = familyOf(record.project.videoModel || config.wangp.videoModel);
    const proposal = await proposeSceneFeedback({
      scene: sources.scene,
      ...request,
      context: {
        ...input,
        prompts: {
          ...input.prompts,
          startFramePrompt: framePromptBody(input.prompts.startFramePrompt),
          endFramePrompt: framePromptBody(input.prompts.endFramePrompt),
          ...(input.generation.rendersVideo ? {
            videoSoundscape: sources.scene.prompts.videoSoundscape,
            videoScore: sources.scene.prompts.videoScore,
          } : {}),
        },
      },
      project: { concept: record.project.concept, style: record.project.style, tone: record.project.tone },
      directives: imagePromptDirective(imageFamily) + (input.generation.rendersVideo
        ? videoPromptDirective(videoFamily, {
          segmentSeconds: sources.scene.trimAtEndSeconds ?? sources.scene.targetDurationSeconds,
          nativeAudio: hasNativeAudio(videoFamily),
        }) : ""),
      provider,
    });
    const { preview } = preparedFeedback(record, sceneId, cast, request.scope, proposal);
    logEvent("scene_feedback.previewed", { projectId, sceneId, scope: request.scope, changes: preview.changes.length });
    return preview;
  });
}

export async function applySceneFeedback(projectId: string, sceneId: string, raw: unknown): Promise<ProjectRecord> {
  const body = sceneFeedbackApplySchema.parse(raw);
  await assertIdle(projectId);
  const record = await getProjectRecord(projectId);
  const cast = await resolveProjectCast(record.project);
  const assertCurrent = (current: ProjectRecord, currentCast: readonly Character[]) => {
    if (sourceHash(current, sceneId, currentCast) !== body.sourceHash) {
      throw new PrerequisiteError("The project or its prompts changed after this preview. Preview again before applying; nothing was saved.");
    }
  };
  assertCurrent(record, cast);
  const { patch } = preparedFeedback(record, sceneId, cast, body.scope, body.proposal);
  const updated = await updateScenePrompts(projectId, sceneId, patch, assertCurrent);
  logEvent("scene_feedback.applied", { projectId, sceneId, scope: body.scope, fields: Object.keys(patch) });
  return updated;
}
