import { audioPlanSchema, type AudioPlan } from "@/lib/schemas/audio";
import { buildAudioPlan, type AudioSceneRef } from "@/lib/agents/mock-audio";
import { executeArtifact, providerCall, type ExecutionCollector } from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
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
  options: { onExecution?: ExecutionCollector; correlationId?: string } = {},
): Promise<AudioPlan> {
  const user = JSON.stringify({ project, scenes });

  const { value, execution } = await executeArtifact<AudioPlan>({
    artifact: "audio_plan",
    scope: "project",
    correlationId: options.correlationId,
    promptVersion: PROMPT_VERSIONS.audio,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: options.onExecution,
    llm: provider
      ? providerCall(provider, AUDIO_DIRECTOR_SYSTEM, user, audioPlanSchema)
      : undefined,
    validate: (plan) =>
      plan.sceneAudioCues.length === scenes.length ? undefined : "short_collection",
    fallback: () => buildAudioPlan(project, scenes),
  });

  // Re-parse so schema defaults (e.g. an omitted `cues` array) are applied.
  return execution.source === "llm"
    ? audioPlanSchema.parse({ ...value, projectId: project.id })
    : value;
}
