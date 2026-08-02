import {
  storyboardExportSchema,
  type StoryboardExport,
} from "@/lib/schemas/exports";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Build and validate the storyboard export artifact (spec Section 2.3).
 * Throws if the record has no generated storyboard yet.
 */
export function buildStoryboardExport(record: ProjectRecord): StoryboardExport {
  if (!record.storyboard) {
    throw new Error("Storyboard has not been generated for this project");
  }
  const artifact = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    project: record.project,
    brief: record.storyboard.brief,
    visualBible: record.storyboard.visualBible,
    scenes: record.storyboard.scenes,
  };
  return storyboardExportSchema.parse(artifact);
}

export function storyboardToJson(record: ProjectRecord): string {
  return JSON.stringify(buildStoryboardExport(record), null, 2);
}

/**
 * Generation manifest: per-scene generation status, chosen attempt, and media
 * paths (spec Section 2.3). Buildable once a storyboard exists.
 */
export function buildGenerationManifest(record: ProjectRecord): unknown {
  if (!record.storyboard) {
    throw new Error("Storyboard has not been generated for this project");
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectId: record.project.id,
    title: record.project.title,
    segmentSeconds: record.project.segmentSeconds,
    // How each artifact was produced. Absent on projects written before
    // provenance existed, which is not the same as "written by a model".
    provenance: record.executions ?? null,
    scenes: record.storyboard.scenes.map((scene) => {
      const attempts = record.attempts?.[scene.id] ?? [];
      const chosen = attempts.find((a) => a.approved) ?? attempts[attempts.length - 1];
      return {
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        status: scene.status,
        prompts: scene.prompts,
        latestAttempt: chosen
          ? {
              attemptNumber: chosen.attemptNumber,
              approved: chosen.approved,
              startImagePath: chosen.startImagePath,
              endImagePath: chosen.endImagePath,
              videoPath: chosen.videoPath,
              qc: chosen.qcResult,
            }
          : null,
      };
    }),
  };
}

export function generationManifestToJson(record: ProjectRecord): string {
  return JSON.stringify(buildGenerationManifest(record), null, 2);
}

export function storyboardToMarkdown(record: ProjectRecord): string {
  const artifact = buildStoryboardExport(record);
  const { project, brief, visualBible, scenes } = artifact;

  const lines: string[] = [];
  lines.push(`# ${project.title}`, "");
  lines.push(`**Logline:** ${brief.logline}`, "");
  lines.push(brief.synopsis, "");
  lines.push(
    `- Requested duration: ${project.requestedDurationSeconds}s`,
    `- Segments: ${project.segmentCount} × ${project.segmentSeconds}s (generated ${project.generatedDurationSeconds}s)`,
    `- Final trim: ${project.finalTrimSeconds}s`,
    `- Aspect ratio: ${project.aspectRatio} · Style: ${project.style} · Tone: ${project.tone}`,
    "",
  );

  lines.push("## Visual bible", "");
  lines.push(`- Art direction: ${visualBible.artDirection}`);
  lines.push(`- Camera style: ${visualBible.cameraStyle}`);
  lines.push(`- Palette: ${visualBible.colorPalette.join(", ")}`, "");

  lines.push("## Scenes", "");
  for (const scene of scenes) {
    lines.push(`### Scene ${scene.sceneNumber} — ${scene.title}`);
    lines.push(
      `_${scene.startTimeSeconds}s–${scene.endTimeSeconds}s_` +
        (scene.trimAtEndSeconds ? ` (trim to ${scene.trimAtEndSeconds}s)` : ""),
      "",
    );
    lines.push(`- Objective: ${scene.sceneObjective}`);
    lines.push(`- Story beat: ${scene.storyBeat}`);
    lines.push(`- Visual: ${scene.visualDescription}`);
    lines.push(`- Action: ${scene.actionDescription}`);
    lines.push(`- Camera: ${scene.cameraMovement}`);
    lines.push(`- Continuity: ${scene.continuityNotes.join("; ")}`, "");
    lines.push(`**Start-frame prompt:** ${scene.prompts.startFramePrompt}`, "");
    lines.push(`**End-frame prompt:** ${scene.prompts.endFramePrompt}`, "");
    lines.push(
      `**Video prompt (${scene.trimAtEndSeconds ?? scene.targetDurationSeconds}s):** ` +
        scene.prompts.videoPromptSegment,
      "",
    );
    lines.push(`**Negative prompt:** ${scene.prompts.videoNegativePrompt}`, "");
  }

  return lines.join("\n");
}
