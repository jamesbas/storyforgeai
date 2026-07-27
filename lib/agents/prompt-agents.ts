import { z } from "zod";
import { scenePromptsSchema, type Scene, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildImagePrompts, buildVideoPrompts } from "@/lib/agents/mock-agents";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const IMAGE_PROMPT_SYSTEM =
  "You are the Image Prompt Agent. For each scene, create a start-frame image prompt and " +
  "end-frame image prompt following the Visual Bible and preserving continuity. Include a " +
  "negative prompt. Return only valid JSON.";

export const videoPromptSystem = (segmentSeconds: number) =>
  "You are the Video Prompt Agent. For each scene, create a WanGP-ready prompt for a " +
  `${segmentSeconds}-second video segment focused on motion, camera movement, action, and ` +
  "scene evolution. Describe only as much action as fits the segment length. " +
  "Include a negative prompt and generation notes. Return only valid JSON.";

/** Default-length wording, retained for callers that have no project in hand. */
export const VIDEO_PROMPT_SYSTEM = videoPromptSystem(SEGMENT_SECONDS);

const imagePartSchema = scenePromptsSchema.pick({
  startFramePrompt: true,
  endFramePrompt: true,
  imageNegativePrompt: true,
});
const videoPartSchema = scenePromptsSchema.pick({
  videoPromptSegment: true,
  videoNegativePrompt: true,
  promptQualityChecklist: true,
});

/**
 * Image + Video prompt agents complete each scene draft into a full Scene by
 * attaching prompts (spec Sections 9.5–9.6). Both fall back to deterministic
 * builders when no provider is available.
 */
export async function attachScenePrompts(
  project: Project,
  drafts: SceneDraft[],
  provider: PlanningProvider | null,
): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const draft of drafts) {
    let imagePart = buildImagePrompts(project, draft);
    let videoPart = buildVideoPrompts(project, draft);

    if (provider) {
      const user = JSON.stringify({ project, scene: draft });
      const image = await provider.generateJson(IMAGE_PROMPT_SYSTEM, user, imagePartSchema);
      if (image) imagePart = image;
      const video = await provider.generateJson(
        videoPromptSystem(project.segmentSeconds),
        user,
        videoPartSchema,
      );
      if (video) videoPart = video;
    }

    scenes.push({ ...draft, prompts: { ...imagePart, ...videoPart } });
  }
  return scenes;
}
