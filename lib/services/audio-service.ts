import { randomUUID } from "node:crypto";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { AudioCue, AudioCueKind, AudioPlan } from "@/lib/schemas/audio";
import { audioCueSchema } from "@/lib/schemas/audio";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildAudioManifest, runToCompletion } from "@/lib/services/wangp-service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

/**
 * Music and SFX cue generation.
 *
 * Dialogue and narration are performed by the video model from the scene
 * prompt, so nothing here synthesizes speech. These cues are the beds that
 * StoryForge generates separately and lays over the cut at assembly.
 */

function requirePlan(record: ProjectRecord): AudioPlan {
  if (!record.audioPlan) throw new ValidationError("Generate an audio plan before working with cues");
  return record.audioPlan;
}

function withPlan(record: ProjectRecord, cues: AudioCue[], action: string, detail: string): ProjectRecord {
  return {
    ...record,
    audioPlan: { ...requirePlan(record), cues },
    history: [...(record.history ?? []), { at: new Date().toISOString(), action, detail }],
  };
}

function sceneDuration(record: ProjectRecord, sceneId: string): number {
  const scene = record.storyboard?.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);
  return scene.trimAtEndSeconds ?? scene.targetDurationSeconds;
}

export type AudioCueInput = {
  sceneId: string;
  kind: AudioCueKind;
  prompt: string;
  startSeconds?: number;
  durationSeconds?: number;
  gainDb?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  duckNativeDb?: number;
};

/** Add a cue anchored to a scene, validating it fits inside that scene. */
export async function addAudioCue(projectId: string, input: AudioCueInput): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = requirePlan(record);
  const available = sceneDuration(record, input.sceneId);

  const startSeconds = input.startSeconds ?? 0;
  if (startSeconds >= available) {
    throw new ValidationError(
      `Cue starts at ${startSeconds}s but scene is only ${available}s long`,
    );
  }
  const durationSeconds = input.durationSeconds ?? available - startSeconds;

  const cue = audioCueSchema.parse({
    id: randomUUID(),
    sceneId: input.sceneId,
    kind: input.kind,
    prompt: input.prompt,
    startSeconds,
    durationSeconds,
    gainDb: input.gainDb ?? (input.kind === "music" ? -8 : -3),
    fadeInSeconds: input.fadeInSeconds ?? (input.kind === "music" ? 1 : 0.05),
    fadeOutSeconds: input.fadeOutSeconds ?? (input.kind === "music" ? 1.5 : 0.05),
    // Music sits under the clip's own audio; an SFX hit sits on top of it.
    duckNativeDb: input.duckNativeDb ?? (input.kind === "music" ? -12 : 0),
    approved: false,
    createdAt: new Date().toISOString(),
  });

  const updated = withPlan(record, [...plan.cues, cue], "audio_cue.added", `${cue.kind} on ${cue.sceneId}`);
  await repository.update(projectId, updated);
  return updated;
}

export async function updateAudioCue(
  projectId: string,
  cueId: string,
  patch: Partial<AudioCueInput>,
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = requirePlan(record);
  const existing = plan.cues.find((c) => c.id === cueId);
  if (!existing) throw new NotFoundError(`Audio cue ${cueId} not found`);

  const next = audioCueSchema.parse({ ...existing, ...patch });
  const available = sceneDuration(record, next.sceneId);
  if (next.startSeconds >= available) {
    throw new ValidationError(`Cue starts at ${next.startSeconds}s but scene is only ${available}s long`);
  }

  // Timing-only edits keep the rendered audio; a prompt change invalidates it.
  const promptChanged = patch.prompt !== undefined && patch.prompt !== existing.prompt;
  const resolved: AudioCue = promptChanged
    ? { ...next, generatedPath: undefined, approved: false }
    : next;

  const updated = withPlan(
    record,
    plan.cues.map((c) => (c.id === cueId ? resolved : c)),
    "audio_cue.updated",
    cueId,
  );
  await repository.update(projectId, updated);
  return updated;
}

export async function removeAudioCue(projectId: string, cueId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = requirePlan(record);
  if (!plan.cues.some((c) => c.id === cueId)) throw new NotFoundError(`Audio cue ${cueId} not found`);

  const updated = withPlan(
    record,
    plan.cues.filter((c) => c.id !== cueId),
    "audio_cue.removed",
    cueId,
  );
  await repository.update(projectId, updated);
  return updated;
}

/** Generate the cue's audio through a WanGP audio model. */
export async function generateAudioCue(projectId: string, cueId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = requirePlan(record);
  const cue = plan.cues.find((c) => c.id === cueId);
  if (!cue) throw new NotFoundError(`Audio cue ${cueId} not found`);

  const manifest = await buildAudioManifest({
    sceneId: cue.sceneId,
    prompt: cue.prompt,
    durationSeconds: cue.durationSeconds,
    modelStrategy: record.project.modelStrategy,
  });
  const job = await runToCompletion(manifest.settings);
  const generatedPath = job.generatedFiles[0];
  if (!generatedPath) throw new Error(`Audio cue ${cueId} produced no file`);

  const updated = withPlan(
    record,
    plan.cues.map((c) =>
      c.id === cueId
        ? { ...c, generatedPath, modelType: manifest.modelType, approved: false }
        : c,
    ),
    "audio_cue.generated",
    `${cue.kind} ${cueId}`,
  );
  await repository.update(projectId, updated);
  logEvent("audio_cue.generated", { projectId, cueId, kind: cue.kind, modelType: manifest.modelType });
  return updated;
}

/** Approve a cue so assembly will mix it in. */
export async function approveAudioCue(
  projectId: string,
  cueId: string,
  approved = true,
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = requirePlan(record);
  const cue = plan.cues.find((c) => c.id === cueId);
  if (!cue) throw new NotFoundError(`Audio cue ${cueId} not found`);
  if (approved && !cue.generatedPath) {
    throw new ValidationError("Generate the cue audio before approving it");
  }

  const updated = withPlan(
    record,
    plan.cues.map((c) => (c.id === cueId ? { ...c, approved } : c)),
    approved ? "audio_cue.approved" : "audio_cue.unapproved",
    cueId,
  );
  await repository.update(projectId, updated);
  return updated;
}
