/**
 * Smoke script — drives the full main path with the in-memory repository and
 * mock adapters, then prints pass/fail (spec Section 20A.1). No external services
 * required: create → storyboard → per-scene media → approve → assemble.
 */
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
} from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { assembleRoughCut } from "@/lib/services/assembly-service";
import { buildStoryboardExport } from "@/lib/export/serialize";

async function main() {
  const project = await createProject({
    concept: "A curious robot learns to paint sunsets.",
    requestedDurationSeconds: 40,
    style: "pixar-like",
    tone: "playful",
  });

  if (project.segmentCount !== 2) {
    throw new Error(`Expected 2 segments for 40s, got ${project.segmentCount}`);
  }

  await generateStoryboard(project.id);
  let record = await getProjectRecord(project.id);
  if (!record.storyboard || record.storyboard.scenes.length !== project.segmentCount) {
    throw new Error("Storyboard scene count does not match segment count");
  }

  const exported = buildStoryboardExport(record);
  if (exported.scenes.length !== project.segmentCount) {
    throw new Error("Export scene count mismatch");
  }

  // Generate + approve media for every scene.
  for (const scene of record.storyboard.scenes) {
    record = await generateSceneMedia(project.id, scene.id);
    const attempts = record.attempts?.[scene.id] ?? [];
    const attempt = attempts[attempts.length - 1]!;
    record = await approveAttempt(project.id, scene.id, attempt.id);
  }

  record = await assembleRoughCut(project.id);
  if (!record.assembly?.roughCutPath) {
    throw new Error("Assembly did not produce a rough cut");
  }
  if (record.assembly.plan.clips.length !== project.segmentCount) {
    throw new Error("Final cut clip count mismatch");
  }

  console.log(
    JSON.stringify({
      event: "smoke.pass",
      projectId: project.id,
      segments: project.segmentCount,
      generatedDurationSeconds: project.generatedDurationSeconds,
      finalTrimSeconds: project.finalTrimSeconds,
      roughCut: record.assembly.roughCutPath,
      totalDurationSeconds: record.assembly.plan.totalDurationSeconds,
    }),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "smoke.fail", error: String(err) }));
  process.exit(1);
});
