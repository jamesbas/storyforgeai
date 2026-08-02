import path from "node:path";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Assembly } from "@/lib/schemas/assembly";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildFinalCutPlan, assemblyPrerequisiteError, assemblyPrerequisites } from "@/lib/media/assembly";
import { getFfmpegRunner, probeMedia } from "@/lib/media/ffmpeg";
import { resolveCueTimeline } from "@/lib/media/audio-mix";
import { listProjectMedia, type MediaDescriptor } from "@/lib/media/refs";
import { generationStages } from "@/lib/types";
import { ValidationError } from "@/lib/errors";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

export type ExportDescriptor = { name: string; url: string; available: boolean };

/**
 * Assemble a rough cut from approved scene clips using the ffmpeg runner
 * (mock in demo mode, native subprocess when FFMPEG_ENABLED).
 *
 * Each clip carries its planned duration, so the native runner applies the
 * per-scene trim during the concat. The last scene's duration already absorbs
 * `trimAtEndSeconds`, which means the concat output lands exactly on the
 * requested runtime — `plan.finalTrimSeconds` records how much generated
 * material was discarded and must not be subtracted a second time.
 */
export async function assembleRoughCut(projectId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  if (!generationStages(record.project.generationMode).assembly) {
    throw new ValidationError(
      "This project's generation mode does not include assembly. Switch it to Full auto on " +
        "the Storyboard screen to assemble a cut.",
    );
  }

  // Approval is a hard boundary: report every unapproved scene before any work.
  const missingApprovals = assemblyPrerequisites(record);
  if (missingApprovals.length) {
    const reasons: Record<string, number> = {};
    for (const m of missingApprovals) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    logEvent("assembly.prerequisite_failed", {
      projectId,
      missing: missingApprovals.length,
      reasons,
    });
    throw assemblyPrerequisiteError(missingApprovals);
  }

  const plan = buildFinalCutPlan(record);

  const runner = getFfmpegRunner();
  const assemblyDir = path.join(config.dataDir, projectId, "assembly");
  const outputPath = path.join(assemblyDir, "rough-cut.mp4");

  const roughCutPath = await runner.concat(
    plan.clips.map((c) => ({ path: c.path, durationSeconds: c.durationSeconds })),
    outputPath,
  );

  // Second pass: lay approved music/SFX cues over the cut. Video is copied, so
  // iterating on audio never re-encodes picture. The rough cut stays intact as
  // the un-scored reference.
  const cues = resolveCueTimeline(plan, record.audioPlan?.cues ?? []);
  let finalPath: string | undefined;
  if (cues.length) {
    finalPath = await runner.mixAudio(
      roughCutPath,
      cues,
      path.join(assemblyDir, "final-cut.mp4"),
    );
  }

  const assembly: Assembly = {
    plan,
    roughCutPath,
    ...(finalPath ? { finalPath } : {}),
    createdAt: new Date().toISOString(),
  };
  const updated: ProjectRecord = {
    ...record,
    assembly,
    project: { ...record.project, status: "assembled", updatedAt: new Date().toISOString() },
    history: [
      ...(record.history ?? []),
      { at: new Date().toISOString(), action: "assembly.completed", detail: `${plan.clips.length} clips` },
    ],
  };

  await repository.update(projectId, updated);

  const probe = runner.mode === "native" ? await probeMedia(finalPath ?? roughCutPath) : null;
  logEvent("assembly.completed", {
    projectId,
    clips: plan.clips.length,
    mode: runner.mode,
    plannedSeconds: plan.totalDurationSeconds,
    audioCues: cues.length,
    attempts: plan.clips.map((c) => `${c.sceneNumber}:${c.attemptId ?? "legacy"}`),
    ...(probe?.durationSeconds == null
      ? {}
      : { actualSeconds: Math.round(probe.durationSeconds * 100) / 100 }),
    ...(probe ? { hasAudio: probe.hasAudio } : {}),
  });
  return updated;
}

/** Servable media descriptors for a project (spec Section 17 playback). */
export async function listMedia(projectId: string): Promise<MediaDescriptor[]> {
  return listProjectMedia(await getProjectRecord(projectId));
}


/** The export package for a project (spec Section 2.3 / 14 exports). */
export async function listExports(projectId: string): Promise<ExportDescriptor[]> {
  const record = await getProjectRecord(projectId);
  const base = `/api/projects/${projectId}/export`;
  const hasStoryboard = Boolean(record.storyboard);
  return [
    { name: "storyboard.json", url: `${base}?format=json`, available: hasStoryboard },
    { name: "storyboard.md", url: `${base}?format=md`, available: hasStoryboard },
    { name: "generation-manifest.json", url: `${base}?format=manifest`, available: hasStoryboard },
    { name: "animatic-plan.json", url: `${base}?format=animatic`, available: Boolean(record.animaticPlan) },
    { name: "final-cut-plan.json", url: `${base}?format=final-cut`, available: Boolean(record.assembly) },
  ];
}
