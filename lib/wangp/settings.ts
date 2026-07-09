import { randomUUID } from "node:crypto";
import type { WangpModelSchema, WangpGenerationSettings, WangpPurpose } from "@/lib/schemas/wangp";

/** 20-second clip frame count derived from FPS (spec Section 11.1). */
export function frameCountForFps(fps: number, seconds = 20): number {
  return fps * seconds + 1;
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
};

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

  const fpsField = schema.fields.find((f) => f.name === "force_fps");
  if (fpsField && overrides.fps !== undefined) {
    const allowed = (fpsField.allowed as number[] | undefined) ?? undefined;
    const fps = allowed && allowed.length > 0 && !allowed.includes(overrides.fps)
      ? allowed[0]!
      : overrides.fps;
    settings.force_fps = fps;
    if (fieldNames.has("video_length")) settings.video_length = frameCountForFps(fps);
  }

  setIf("image_start", overrides.imageStart);
  setIf("image_end", overrides.imageEnd);

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
