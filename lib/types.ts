/**
 * Single source of truth for domain enumerations.
 * Declared as const arrays + derived union types so the same values are reused
 * across Zod schemas, the data layer, and tests (generic-build-spec Section 5.3).
 */

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "custom"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTION_PRESETS = ["draft", "standard", "high"] as const;
export type ResolutionPreset = (typeof RESOLUTION_PRESETS)[number];

export const GENERATION_MODES = [
  "storyboard_only",
  "keyframes_only",
  "video_segments",
  "full_auto",
] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/**
 * What each generation mode permits.
 *
 * The modes are cumulative stages of one pipeline, so this is the single place
 * that decides how far a project is allowed to run. Enforced in the services
 * rather than only hidden in the UI: a mode that merely greys out a button is
 * a suggestion, and the API is reachable without it.
 *
 * Assembly rides with video rather than being reserved for `full_auto`. It is a
 * manual step over clips that already exist, so forbidding it would only strand
 * a project that had finished rendering. What `full_auto` adds is that nobody
 * has to press start.
 */
export function generationStages(mode: GenerationMode): {
  keyframes: boolean;
  video: boolean;
  assembly: boolean;
  /** Whether generating the storyboard should start the media queue by itself. */
  autoStart: boolean;
} {
  const video = mode === "video_segments" || mode === "full_auto";
  return {
    keyframes: mode !== "storyboard_only",
    video,
    assembly: video,
    autoStart: mode === "full_auto",
  };
}

export const MODEL_STRATEGIES = [
  "auto",
  "prefer_wan",
  "prefer_ltx",
  "prefer_hunyuan",
  "manual",
] as const;
export type ModelStrategy = (typeof MODEL_STRATEGIES)[number];

export const CREATIVE_MODES = [
  "film_short",
  "microdrama",
  "youtube_video",
  "shorts_reels_tiktok",
  "brand_ad",
  "product_demo",
  "educational_explainer",
  "ai_avatar",
  "social_campaign",
] as const;
export type CreativeMode = (typeof CREATIVE_MODES)[number];

export const PROJECT_STATUSES = [
  "draft",
  "storyboard_ready",
  "generating",
  "needs_review",
  "approved",
  "assembled",
  "failed",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SCENE_STATUSES = [
  "planned",
  "ready",
  "generating",
  "generated",
  "needs_review",
  "approved",
  "failed",
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const VARIANT_TYPES = [
  "concept",
  "story",
  "visual_style",
  "hook",
  "scene",
  "platform_cut",
] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

export const SEGMENT_SECONDS = 20;

/**
 * How each scene's video connects to the one before it.
 *
 * Scenes are rendered as independent jobs, so by default nothing ties scene 3
 * to scene 2 beyond the prompt. These modes trade render cost against visual
 * continuity at the seam.
 *
 * - `cut`             Fresh start and end keyframes per scene. Correct when
 *                     scenes are separate shots — reusing a frame across a hard
 *                     cut reads as a freeze, not a flow.
 * - `reuse_end_frame` Scene N+1 starts from scene N's end frame. Saves one
 *                     image render per boundary and guarantees the seam
 *                     matches, but only makes sense for continuous action.
 * - `continue_video`  Scene N+1 continues from scene N's rendered clip via the
 *                     video model's own continuation support. Best motion
 *                     continuity; needs a model advertising `video.continue`.
 */
export const SCENE_CONTINUITY_MODES = ["cut", "reuse_end_frame", "continue_video"] as const;
export type SceneContinuityMode = (typeof SCENE_CONTINUITY_MODES)[number];

/**
 * The mode used when a project does not state one.
 *
 * Named rather than repeated as a literal because it is applied in several
 * places — the create form, the runtime resolver, and the labels — and those
 * drifting apart would mean the UI advertising one default while generation
 * used another.
 *
 * `reuse_end_frame` is the default because most projects here are one continuous
 * piece rather than a reel of unrelated shots: it makes each seam match exactly
 * and cuts image renders from 2N to N+1. Set `cut` per project when scenes are
 * genuinely separate.
 */
export const DEFAULT_SCENE_CONTINUITY: SceneContinuityMode = "reuse_end_frame";

/**
 * Bounds for a configurable clip length. The ceiling is the video model's native
 * window (LTX-2 defaults to video_length 481 = 20s at 24fps); going beyond it
 * needs WanGP's sliding-window mode, which costs proportionally more time and
 * drifts in subject coherence. The floor keeps a clip long enough to carry a
 * camera move.
 */
export const MIN_SEGMENT_SECONDS = 5;
export const MAX_SEGMENT_SECONDS = 20;
