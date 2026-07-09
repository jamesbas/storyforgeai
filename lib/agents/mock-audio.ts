import type { Project } from "@/lib/schemas/project";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { AnimaticPlan, AudioPlan, VoiceProfile } from "@/lib/schemas/audio";

/** Deterministic builders for the audio plan and animatic plan (spec 2A.5 / 2A.7). */

export function buildAudioPlan(project: Project, sceneIds: string[]): AudioPlan {
  const voiceProfiles: VoiceProfile[] = [];
  if (project.narrationRequired) {
    voiceProfiles.push({
      id: `${project.id}-voice-narrator`,
      name: "Narrator",
      role: "narrator",
      voiceDescription: `Warm, ${project.tone} narrator suited to a ${project.style} piece.`,
      pacing: "measured",
      emotion: project.tone,
    });
  }
  if (project.dialogueRequired) {
    voiceProfiles.push({
      id: `${project.id}-voice-lead`,
      name: "Lead Character",
      role: "character",
      voiceDescription: "Distinct, expressive character voice.",
      emotion: project.tone,
    });
  }

  const sceneAudioCues = sceneIds.map((sceneId, i) => ({
    sceneId,
    narrationText: project.narrationRequired ? `Narration for scene ${i + 1}.` : undefined,
    dialogueLines: project.dialogueRequired
      ? [{ character: "Lead Character", line: `Line for scene ${i + 1}.` }]
      : undefined,
    musicCue: project.musicRequired ? "Underscore supporting the beat." : undefined,
    sfxCues: project.sfxRequired ? ["ambient bed", "accent hit"] : undefined,
    lipSyncRequired: project.dialogueRequired,
  }));

  return {
    projectId: project.id,
    narrationRequired: project.narrationRequired,
    dialogueRequired: project.dialogueRequired,
    musicRequired: project.musicRequired,
    sfxRequired: project.sfxRequired,
    voiceProfiles,
    sceneAudioCues,
    musicDirection: project.musicRequired
      ? `${project.tone} score that tracks the emotional arc.`
      : undefined,
    sfxLibraryNotes: project.sfxRequired ? "Use subtle, diegetic effects." : undefined,
  };
}

/**
 * Build an animatic plan from an approved/generated storyboard. Assembly of an
 * actual preview video is deferred until media generation exists (Phase 4/5), so
 * `previewAssembled` reflects only whether the assembly flag is enabled.
 */
export function buildAnimaticPlan(record: ProjectRecord): AnimaticPlan {
  if (!record.storyboard) {
    throw new Error("An animatic requires a generated storyboard");
  }
  const frames = record.storyboard.scenes.map((s) => ({
    sceneNumber: s.sceneNumber,
    caption: s.narrationText ?? s.sceneObjective,
    durationSeconds: s.trimAtEndSeconds ?? s.targetDurationSeconds,
    transitionIn: s.transitionIn,
    transitionOut: s.transitionOut,
    startFramePrompt: s.prompts.startFramePrompt,
    endFramePrompt: s.prompts.endFramePrompt,
  }));

  const sceneDurationMap: Record<string, number> = {};
  for (const f of frames) sceneDurationMap[String(f.sceneNumber)] = f.durationSeconds;
  const totalDurationSeconds = frames.reduce((sum, f) => sum + f.durationSeconds, 0);

  return {
    projectId: record.project.id,
    totalDurationSeconds,
    frames,
    sceneDurationMap,
    // Assembling an actual preview video is deferred until media generation
    // exists (Phase 4/5); the plan is metadata-only for now.
    previewAssembled: false,
    previewPath: undefined,
  };
}
