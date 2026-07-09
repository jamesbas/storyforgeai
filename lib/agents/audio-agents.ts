import { audioPlanSchema, type AudioPlan } from "@/lib/schemas/audio";
import { buildAudioPlan } from "@/lib/agents/mock-audio";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const AUDIO_DIRECTOR_SYSTEM =
  "You are the Audio Director Agent. Create a project-level audio plan covering narration, " +
  "dialogue, music direction, ambient sound, SFX, and per-scene audio cues. If lip-sync is " +
  "required, flag the scenes and voice profiles that need it. Return only valid JSON matching " +
  "the AudioPlan schema.";

export async function audioDirectorAgent(
  project: Project,
  sceneIds: string[],
  provider: PlanningProvider | null,
): Promise<AudioPlan> {
  if (provider) {
    const user = JSON.stringify({ project, sceneIds });
    const result = await provider.generateJson(AUDIO_DIRECTOR_SYSTEM, user, audioPlanSchema);
    if (result && result.sceneAudioCues.length === sceneIds.length) {
      return { ...result, projectId: project.id };
    }
  }
  return buildAudioPlan(project, sceneIds);
}
