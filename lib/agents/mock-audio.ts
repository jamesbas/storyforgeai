import type { Project } from "@/lib/schemas/project";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { AnimaticPlan, AudioCue, AudioPlan, VoiceProfile } from "@/lib/schemas/audio";

/** Deterministic builders for the audio plan and animatic plan (spec 2A.5 / 2A.7). */

/** Scene context the Audio Director needs to place cues on a timeline. */
export type AudioSceneRef = {
  id: string;
  sceneNumber: number;
  durationSeconds: number;
};

/**
 * Propose a music bed for a scene.
 *
 * Music enters just after the scene opens and ends a beat before the cut, so it
 * reads as scored rather than abutting the edit. Ducks the clip's own audio so
 * any dialogue the video model rendered stays intelligible.
 */
function musicCueFor(project: Project, scene: AudioSceneRef): AudioCue {
  const startSeconds = Math.min(2, Math.max(0, scene.durationSeconds - 2));
  const durationSeconds = Math.max(1, scene.durationSeconds - startSeconds - 1);
  return {
    id: `${project.id}-cue-music-${String(scene.sceneNumber).padStart(3, "0")}`,
    sceneId: scene.id,
    kind: "music",
    prompt: `${project.tone} underscore for a ${project.style} scene; no vocals, supports the beat without competing with dialogue.`,
    startSeconds,
    durationSeconds,
    gainDb: -8,
    fadeInSeconds: 1,
    fadeOutSeconds: 1.5,
    duckNativeDb: -12,
    approved: false,
  };
}

/** Propose a short SFX accent, mixed on top of the clip's own audio. */
function sfxCueFor(project: Project, scene: AudioSceneRef): AudioCue {
  const startSeconds = Math.min(1, Math.max(0, scene.durationSeconds - 1));
  return {
    id: `${project.id}-cue-sfx-${String(scene.sceneNumber).padStart(3, "0")}`,
    sceneId: scene.id,
    kind: "sfx",
    prompt: `Subtle diegetic accent that punctuates the opening of a ${project.tone} ${project.style} scene.`,
    startSeconds,
    durationSeconds: Math.min(3, Math.max(1, scene.durationSeconds - startSeconds)),
    gainDb: -3,
    fadeInSeconds: 0.05,
    fadeOutSeconds: 0.05,
    duckNativeDb: 0,
    approved: false,
  };
}

export function buildAudioPlan(project: Project, scenes: AudioSceneRef[]): AudioPlan {
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

  const sceneAudioCues = scenes.map((scene, i) => ({
    sceneId: scene.id,
    narrationText: project.narrationRequired ? `Narration for scene ${i + 1}.` : undefined,
    dialogueLines: project.dialogueRequired
      ? [{ character: "Lead Character", line: `Line for scene ${i + 1}.` }]
      : undefined,
    musicCue: project.musicRequired ? "Underscore supporting the beat." : undefined,
    sfxCues: project.sfxRequired ? ["ambient bed", "accent hit"] : undefined,
  }));

  const cues: AudioCue[] = [];
  for (const scene of scenes) {
    if (project.musicRequired) cues.push(musicCueFor(project, scene));
    if (project.sfxRequired) cues.push(sfxCueFor(project, scene));
  }

  return {
    projectId: project.id,
    narrationRequired: project.narrationRequired,
    dialogueRequired: project.dialogueRequired,
    musicRequired: project.musicRequired,
    sfxRequired: project.sfxRequired,
    voiceProfiles,
    sceneAudioCues,
    cues,
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
