import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Assembly } from "@/lib/schemas/assembly";
import { repository } from "@/lib/db/store";
import { getProjectRecord } from "@/lib/services/project-service";
import { buildFinalCutPlan } from "@/lib/media/assembly";
import { getFfmpegRunner } from "@/lib/media/ffmpeg";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

export type ExportDescriptor = { name: string; url: string; available: boolean };

/**
 * Assemble a rough cut from approved scene clips using the ffmpeg runner
 * (mock in demo mode). Stores the final-cut plan and rough-cut path.
 */
export async function assembleRoughCut(projectId: string): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const plan = buildFinalCutPlan(record);

  const runner = getFfmpegRunner();
  const outputPath = `${config.dataDir}/${projectId}/assembly/rough-cut.mp4`;
  const roughCutPath = await runner.concat(
    plan.clips.map((c) => c.path),
    outputPath,
  );

  const assembly: Assembly = { plan, roughCutPath, createdAt: new Date().toISOString() };
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
  logEvent("assembly.completed", { projectId, clips: plan.clips.length, mode: runner.mode });
  return updated;
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
