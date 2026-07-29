import { z } from "zod";
import { scenePromptsSchema, type Scene, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildImagePrompts, buildVideoPrompts } from "@/lib/agents/mock-agents";
import { castNegativeSuffix, castPromptSuffix, castSystemDirective } from "@/lib/agents/cast";
import { lookPromptSuffix } from "@/lib/agents/look";
import {
  continuityNegativeSuffix,
  precedenceDirective,
  sceneCreativeSlice,
  type CreativePlans,
} from "@/lib/agents/creative-context";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { Character } from "@/lib/schemas/character";
import type { VisualBible } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

/** Planning artifacts the prompt agents read but do not modify. */
export type ScenePromptContext = {
  cast?: readonly Character[];
  visualBible?: VisualBible;
  plans?: CreativePlans;
};

export const IMAGE_PROMPT_SYSTEM =
  "You are the Image Prompt Agent. For each scene, create a start-frame image prompt and " +
  "end-frame image prompt following the Visual Bible and preserving continuity. Include a " +
  "negative prompt. Return only valid JSON." +
  // The two frames are rendered as independent jobs, so anything left vague is
  // reinvented on each pass. A prompt reading "casual contemporary attire"
  // produced black trousers in one frame and blue jeans in the next.
  " The start and end frame are the same moment seconds apart: every character must wear " +
  "identical clothing in both, and the location, lighting and time of day must match. " +
  "For any character who is not in the supplied cast, state the wardrobe as specific named " +
  "garments with colours and materials — never a vague placeholder such as 'casual attire', " +
  "'contemporary clothing' or 'appropriate outfit' — and repeat that same wardrobe wording " +
  "verbatim in both prompts. Only framing, pose and action may differ between them. " +
  // Same reasoning as the cast sheet: the look is appended verbatim, so a
  // second mention only doubles the term's weight in the render.
  "Do not restate the project's style or tone; both are appended to every prompt automatically.";

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
 *
 * The Visual Bible is passed alongside the scene so the prompt agents can honour
 * the continuity rules they are told to follow, and the pinned cast is passed so
 * a character's locked description reaches the render itself rather than only
 * the plan.
 */
export async function attachScenePrompts(
  project: Project,
  drafts: SceneDraft[],
  provider: PlanningProvider | null,
  context: ScenePromptContext = {},
): Promise<Scene[]> {
  const cast = context.cast ?? [];
  const plans = context.plans;
  const scenes: Scene[] = [];
  for (const draft of drafts) {
    // Only this scene's slice of the Director and Cinematographer plans travels
    // into the prompt. The full documents would crowd out the shot description.
    const slice = sceneCreativeSlice(plans, draft);
    let imagePart = buildImagePrompts(project, draft, cast, plans);
    let videoPart = buildVideoPrompts(project, draft, cast, plans);

    if (provider) {
      const user = JSON.stringify({
        project,
        scene: draft,
        visualBible: context.visualBible,
        cast,
        sceneIntent: slice.intent,
        shotPlan: slice.shotPlan,
        artDirection: plans?.artDirectionPlan,
        cameraRules: plans?.cinematographyPlan
          ? {
              cameraLanguage: plans.cinematographyPlan.cameraLanguage,
              lensAndFramingRules: plans.cinematographyPlan.lensAndFramingRules,
              movementRules: plans.cinematographyPlan.movementRules,
              lightingRules: plans.cinematographyPlan.lightingRules,
            }
          : undefined,
        forbiddenContradictions: plans?.worldBible?.forbiddenContradictions,
      });
      const image = await provider.generateJson(
        IMAGE_PROMPT_SYSTEM + castSystemDirective(cast, true) + precedenceDirective(cast, plans),
        user,
        imagePartSchema,
      );
      if (image) imagePart = withCastEnforced(image, cast, plans, project);
      const video = await provider.generateJson(
        videoPromptSystem(project.segmentSeconds) +
          castSystemDirective(cast, true) +
          precedenceDirective(cast, plans),
        user,
        videoPartSchema,
      );
      if (video) videoPart = withCastEnforcedVideo(video, cast, plans, project);
    }

    scenes.push({ ...draft, prompts: { ...imagePart, ...videoPart } });
  }
  return scenes;
}

type ImagePart = z.infer<typeof imagePartSchema>;
type VideoPart = z.infer<typeof videoPartSchema>;

/**
 * Re-append the look, the cast sheet and world-continuity constraints to
 * model-authored prompts.
 *
 * Each scene is rendered as an independent job, so a description the model
 * summarised away in scene 3 is a face that changes on screen. The same holds
 * for the project's style and tone: left to the model, they landed in some
 * scenes' prompts and not others, and the look drifted across the cut.
 * Appending the canonical text costs a few tokens and removes both failures.
 */
function withCastEnforced(
  part: ImagePart,
  cast: readonly Character[],
  plans: CreativePlans | undefined,
  project: Project,
): ImagePart {
  const suffix = castPromptSuffix(cast);
  const negative = `${castNegativeSuffix(cast, part.imageNegativePrompt)}${continuityNegativeSuffix(plans)}`;
  return {
    startFramePrompt: `${part.startFramePrompt}${lookPromptSuffix(project, part.startFramePrompt)}${suffix}`,
    endFramePrompt: `${part.endFramePrompt}${lookPromptSuffix(project, part.endFramePrompt)}${suffix}`,
    imageNegativePrompt: `${part.imageNegativePrompt}${negative}`,
  };
}

function withCastEnforcedVideo(
  part: VideoPart,
  cast: readonly Character[],
  plans: CreativePlans | undefined,
  project: Project,
): VideoPart {
  const suffix = castPromptSuffix(cast);
  const negative = `${castNegativeSuffix(cast, part.videoNegativePrompt)}${continuityNegativeSuffix(plans)}`;
  return {
    ...part,
    videoPromptSegment: `${part.videoPromptSegment}${lookPromptSuffix(project, part.videoPromptSegment)}${suffix}`,
    videoNegativePrompt: `${part.videoNegativePrompt}${negative}`,
  };
}
