import path from "node:path";
import fs from "node:fs/promises";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Assembly } from "@/lib/schemas/assembly";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildFinalCutPlan, assemblyPrerequisiteError, assemblyPrerequisites } from "@/lib/media/assembly";
import { cutFileName } from "@/lib/export/file-name";
import { getFfmpegRunner, probeMedia } from "@/lib/media/ffmpeg";
import { resolveCueTimeline } from "@/lib/media/audio-mix";
import { listProjectMedia, type MediaDescriptor } from "@/lib/media/refs";
import { generationStages } from "@/lib/types";
import { ValidationError } from "@/lib/errors";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

export type ExportDescriptor = { name: string; url: string; available: boolean };

/**
 * Delete the cuts a fresh assembly has replaced.
 *
 * Deliberately narrow: only the two paths the previous assembly recorded, only
 * when they sit directly inside this project's own assembly folder, and only
 * when the new assembly did not write to the same name. A stored path is the
 * one thing here that was not derived a moment ago, so it is checked rather
 * than trusted.
 */
async function removeSupersededCuts(
  assemblyDir: string,
  previous: Assembly | undefined,
  keep: readonly (string | undefined)[],
): Promise<void> {
  if (!previous) return;

  const kept = new Set(
    keep.filter((p): p is string => Boolean(p)).map((p) => path.resolve(p)),
  );

  for (const candidate of [previous.roughCutPath, previous.finalPath]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (kept.has(resolved)) continue;
    if (path.dirname(resolved) !== path.resolve(assemblyDir)) continue;

    try {
      await fs.rm(resolved, { force: true });
    } catch {
      // A locked or already-removed file is not worth failing an assembly for.
    }
  }
}

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
  // One timestamp for both passes: they are two outputs of a single assembly,
  // and a minute boundary falling between them would suggest otherwise.
  const assembledAt = new Date();
  const outputPath = path.join(
    assemblyDir,
    cutFileName(record.project.title, "rough-cut", assembledAt),
  );

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
      path.join(assemblyDir, cutFileName(record.project.title, "final-cut", assembledAt)),
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

  // The previous cut is superseded, not history: its name now carries the wrong
  // timestamp and nothing in the record points at it. Best-effort and after the
  // record is written, so a file that cannot be removed leaves clutter rather
  // than losing the assembly that just succeeded.
  await removeSupersededCuts(assemblyDir, record.assembly, [roughCutPath, finalPath]);

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
