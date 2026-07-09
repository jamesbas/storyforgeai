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
