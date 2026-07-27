import { randomUUID } from "node:crypto";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { WangpModelSchema, WangpGenerationSettings, WangpPurpose } from "@/lib/schemas/wangp";

/**
 * Frame count for a clip of `seconds` at `fps`, aligned to WanGP's 8-frame
 * boundary plus one (spec Section 11.1). Matches the alignment WanGP requires
 * for `video_length`; at the default 20s and 16/24/30 fps this equals fps*20+1.
 */
export function frameCountForFps(fps: number, seconds = SEGMENT_SECONDS): number {
  return Math.ceil((fps * seconds) / 8) * 8 + 1;
}

export type ManifestOverrides = {
  sceneId: string;
  purpose: WangpPurpose;
  prompt: string;
  negativePrompt?: string;
  imageStart?: string;
  imageEnd?: string;
  fps?: number;
  resolution?: string;
  /** Audio models: clip length in seconds. Video: segment length for frame maths. */
  durationSeconds?: number;
};

/**
 * Pick a frame rate: honour a discrete choice list, else clamp to any published
 * range, else use the requested value. Falls back to 24 (LTX-2's native rate)
 * when the model publishes nothing.
 */
function resolveFps(
  field: { allowed?: unknown[]; min?: number; max?: number } | undefined,
  requested: number | undefined,
): number {
  let fps = requested ?? 24;
  const allowed = field?.allowed as number[] | undefined;
  if (allowed?.length) {
    if (!allowed.includes(fps)) fps = allowed[0]!;
    return fps;
  }
  if (field?.min !== undefined) fps = Math.max(field.min, fps);
  if (field?.max !== undefined) fps = Math.min(field.max, fps);
  return fps;
}

/**
 * Build a settings manifest from a model's default settings, changing only
 * schema-supported fields (spec Sections 11.2 / 11.3). FPS and video length are
 * validated against the model's allowed values when present.
 */
export function buildSettingsManifest(
  schema: WangpModelSchema,
  overrides: ManifestOverrides,
): WangpGenerationSettings {
  const settings: Record<string, unknown> = { ...schema.defaultSettings };
  const fieldNames = new Set(schema.fields.map((f) => f.name));

  const setIf = (name: string, value: unknown) => {
    if (fieldNames.has(name) && value !== undefined) settings[name] = value;
  };

  setIf("prompt", overrides.prompt);
  setIf("negative_prompt", overrides.negativePrompt ?? "");
  setIf("resolution", overrides.resolution);

  // WanGP can rewrite the prompt with its own local LLM before generating.
  // Several models ship with it enabled (LTX-2 22B defaults to "T"), which
  // would silently discard the prompts our agents crafted. Always disable it.
  if (fieldNames.has("prompt_enhancer")) settings.prompt_enhancer = "";

  // Frame count and frame rate are independent controls. Some models expose
  // `force_fps` (often as an empty string meaning "model native"), some expose
  // none at all — LTX-2 19B has `video_length` but no fps field whatsoever.
  // Setting video_length only when an fps field existed silently left every
  // clip at the model's default length, ignoring the segment duration.
  const fpsField = schema.fields.find((f) => f.name === "force_fps");
  const fps = resolveFps(fpsField, overrides.fps);

  if (fpsField && overrides.fps !== undefined && typeof schema.defaultSettings.force_fps === "number") {
    // Only pin fps when the model genuinely drives it numerically.
    settings.force_fps = fps;
  }

  if (fieldNames.has("video_length") && overrides.fps !== undefined) {
    const lengthField = schema.fields.find((f) => f.name === "video_length");
    let frames = frameCountForFps(fps, overrides.durationSeconds ?? SEGMENT_SECONDS);
    if (lengthField?.min !== undefined) frames = Math.max(lengthField.min, frames);
    if (lengthField?.max !== undefined) frames = Math.min(lengthField.max, frames);
    settings.video_length = frames;
  }

  setIf("image_start", overrides.imageStart);
  setIf("image_end", overrides.imageEnd);

  // Audio models express length in seconds, clamped to any published bounds.
  const durationField = schema.fields.find((f) => f.name === "duration_seconds");
  if (durationField && overrides.durationSeconds !== undefined) {
    let seconds = overrides.durationSeconds;
    if (durationField.min !== undefined) seconds = Math.max(durationField.min, seconds);
    if (durationField.max !== undefined) seconds = Math.min(durationField.max, seconds);
    settings.duration_seconds = seconds;
  }

  return {
    id: randomUUID(),
    sceneId: overrides.sceneId,
    purpose: overrides.purpose,
    modelType: schema.modelType,
    settings,
    status: "draft",
    generatedFiles: [],
    errors: [],
  };
}
