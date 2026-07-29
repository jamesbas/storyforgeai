import type { ModelCapability, WangpModel } from "@/lib/schemas/wangp";
import type { Project } from "@/lib/schemas/project";

/** Minimal preferences the router needs (avoids requiring a full Project). */
export type ModelPreference = { modelStrategy: Project["modelStrategy"] };

/**
 * An exact model pin. WanGP exposes ~200 models and publishes no quality
 * ranking, so automatic selection cannot distinguish a general text-to-image
 * model from an inpainting, editing, or avatar variant — with everything tied
 * at the same score the winner is just whichever WanGP listed first. A pin is
 * the only reliable way to get a specific model in a live catalog.
 */
export function findPinned(models: WangpModel[], pinned: string | undefined): WangpModel | null {
  if (!pinned) return null;
  return models.find((m) => m.modelType === pinned) ?? null;
}

/** Convert a discovered WanGP model into capability tags (spec Section 2A.8). */
export function toCapability(model: WangpModel): ModelCapability {
  const image = model.metadata.mediaInputs?.image;
  const audio = model.metadata.mediaInputs?.audio;
  const outputs = model.metadata.outputs?.length
    ? model.metadata.outputs
    : [model.metadata.mainOutput];
  return {
    modelType: model.modelType,
    provider: "wangp",
    outputs,
    inputs: model.metadata.inputs,
    supportsStartFrame: Boolean(image?.start),
    supportsEndFrame: Boolean(image?.end),
    supportsReferenceImages: Boolean(image?.reference),
    supportsLora: Boolean(model.metadata.supportsLora),
    supportsAudioOutput: Boolean(audio?.output) || outputs.includes("audio"),
    acceptsAudioPrompt: Boolean(audio?.prompt) || model.metadata.inputs.includes("audio"),
    maxFrames: model.metadata.maxFrames,
    recommendedFps: model.metadata.recommendedFps,
    vramProfile: model.metadata.vramProfile,
    qualityRank: model.metadata.qualityRank,
  };
}

/**
 * How many reference images a model is worth sending.
 *
 * Flux 2 takes up to four and identity improves with each one. Everything else
 * is held at two: more references on a model that only conditions on the first
 * few dilutes the prompt rather than sharpening the likeness.
 */
export function referenceImageCapacity(model: { modelType: string }): number {
  return model.modelType.startsWith("flux2") ? 4 : 2;
}

function strategyBonus(modelType: string, strategy: Project["modelStrategy"]): number {
  switch (strategy) {    case "prefer_wan":
      return modelType.includes("wan") ? 100 : 0;
    case "prefer_ltx":
      return modelType.includes("ltx") ? 100 : 0;
    case "prefer_hunyuan":
      return modelType.includes("hunyuan") ? 100 : 0;
    default:
      return 0;
  }
}

/**
 * Every output a model can produce. WanGP reports `main_output` as a list, and
 * models that switch between stills and motion report `["image","video"]` —
 * LTX-2 does exactly this. Filtering on the first entry alone would classify
 * LTX-2 as an image model and hide it from video selection entirely.
 */
function outputsOf(model: WangpModel): readonly string[] {
  return model.metadata.outputs?.length ? model.metadata.outputs : [model.metadata.mainOutput];
}

export function produces(model: WangpModel, output: "image" | "video" | "audio"): boolean {
  return outputsOf(model).includes(output);
}

/**
 * Models WanGP has to download before it can render. Submitting a job for one
 * of these succeeds, but stalls for however long the weights take to fetch.
 */
export function isInstalled(model: WangpModel): boolean {
  return model.metadata.availability !== "missing";
}

/** Rank installed models ahead of ones that would trigger a download. */
function installedBonus(model: WangpModel): number {
  if (model.metadata.availability === "available") return 10_000;
  if (model.metadata.availability === "partial") return 5_000;
  if (model.metadata.availability === "missing") return 0;
  return 2_500; // unknown — neither trusted nor excluded
}

/**
 * Rank video models for scene continuity: prefer image start-frame support, then
 * the project's model strategy, then quality rank (spec Section 11.3).
 */
export function rankVideoModels(models: WangpModel[], project: ModelPreference): WangpModel[] {
  return [...models]
    .filter((m) => produces(m, "video"))
    .map((m) => ({ model: m, cap: toCapability(m) }))
    .sort((a, b) => {
      const startA = a.cap.supportsStartFrame ? 1000 : 0;
      const startB = b.cap.supportsStartFrame ? 1000 : 0;
      const scoreA =
        installedBonus(a.model) + startA + strategyBonus(a.model.modelType, project.modelStrategy) + (a.cap.qualityRank ?? 0);
      const scoreB =
        installedBonus(b.model) + startB + strategyBonus(b.model.modelType, project.modelStrategy) + (b.cap.qualityRank ?? 0);
      return scoreB - scoreA;
    })
    .map((entry) => entry.model);
}

export function selectVideoModel(models: WangpModel[], project: ModelPreference): WangpModel | null {
  const ranked = rankVideoModels(models, project);
  return ranked[0] ?? null;
}

/**
 * Preferred default families for text-to-image stills, best first.
 *
 * WanGP publishes no quality ranking, so without a nudge the "best" image model
 * is whichever the catalog happened to list first. Flux 2 Klein is a
 * text-to-image model that also accepts reference images, which makes it the
 * right default for storyboard keyframes: the same model can render a frame
 * with or without a pinned character.
 */
const IMAGE_MODEL_PREFERENCE = ["flux2_klein", "flux2", "qwen_image", "flux"] as const;

function imageFamilyBonus(modelType: string): number {
  const index = IMAGE_MODEL_PREFERENCE.findIndex((family) => modelType.startsWith(family));
  return index === -1 ? 0 : (IMAGE_MODEL_PREFERENCE.length - index) * 10;
}

export function selectImageModel(
  models: WangpModel[],
  project: ModelPreference,
  /**
   * Restrict to models that accept reference images. Set when the project pins
   * characters from the library — a model without reference support would
   * silently drop them, which looks like the feature simply not working.
   */
  options: { requireReferenceImages?: boolean } = {},
): WangpModel | null {
  const candidates = models
    .filter((m) => produces(m, "image"))
    .filter((m) => !options.requireReferenceImages || toCapability(m).supportsReferenceImages);

  const images = candidates.sort(
    (a, b) =>
      installedBonus(b) - installedBonus(a) ||
      strategyBonus(b.modelType, project.modelStrategy) - strategyBonus(a.modelType, project.modelStrategy) ||
      // Prefer a dedicated stills model over a video model running in image
      // mode. `mainOutput` cannot distinguish them — LTX-2 reports "image"
      // first — so test whether the model also produces video.
      Number(!produces(b, "video")) - Number(!produces(a, "video")) ||
      imageFamilyBonus(b.modelType) - imageFamilyBonus(a.modelType) ||
      (b.metadata.qualityRank ?? 0) - (a.metadata.qualityRank ?? 0),
  );
  return images[0] ?? null;
}

/** Does this model accept reference images for identity conditioning? */
export function supportsReferenceImages(model: WangpModel): boolean {
  return toCapability(model).supportsReferenceImages;
}

/**
 * Video models that render their own soundtrack (WanGP `returns_audio`, e.g.
 * LTX-2). Used to decide whether a scene needs a separate audio pass.
 */
export function videoModelsWithAudio(models: WangpModel[]): WangpModel[] {
  return models.filter((m) => produces(m, "video") && toCapability(m).supportsAudioOutput);
}

/**
 * Dedicated audio generators (WanGP `audio_only`: ACE-Step, Stable Audio 3,
 * TTS families). Reached through the same `wangp_generate` tool as video.
 */
export function selectAudioModel(models: WangpModel[], project: ModelPreference): WangpModel | null {
  const audio = models
    .filter((m) => m.metadata.mainOutput === "audio")
    .sort(
      (a, b) =>
        installedBonus(b) - installedBonus(a) ||
        strategyBonus(b.modelType, project.modelStrategy) - strategyBonus(a.modelType, project.modelStrategy) ||
        (b.metadata.qualityRank ?? 0) - (a.metadata.qualityRank ?? 0),
    );
  return audio[0] ?? null;
}
