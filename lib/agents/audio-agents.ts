import { audioPlanSchema, type AudioPlan } from "@/lib/schemas/audio";
import { buildAudioPlan, type AudioSceneRef } from "@/lib/agents/mock-audio";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const AUDIO_DIRECTOR_SYSTEM =
  "You are the Audio Director Agent. Create a project-level audio plan. Dialogue and narration " +
  "are performed by the video model from each scene's prompt, so do not plan speech synthesis. " +
  "Plan music and SFX beds that StoryForge generates separately: for each, give an anchor scene, " +
  "a start offset within that scene, a duration, and a prompt describing the sound. Return only " +
  "valid JSON matching the AudioPlan schema.";

export async function audioDirectorAgent(
  project: Project,
  scenes: AudioSceneRef[],
  provider: PlanningProvider | null,
): Promise<AudioPlan> {
  if (provider) {
    const user = JSON.stringify({ project, scenes });
    const result = await provider.generateJson(AUDIO_DIRECTOR_SYSTEM, user, audioPlanSchema);
    if (result && result.sceneAudioCues.length === scenes.length) {
      // Re-parse so schema defaults (e.g. an omitted `cues` array) are applied.
      return audioPlanSchema.parse({ ...result, projectId: project.id });
    }
  }
  return buildAudioPlan(project, scenes);
}
