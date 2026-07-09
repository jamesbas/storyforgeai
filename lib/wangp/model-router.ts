import type { ModelCapability, WangpModel } from "@/lib/schemas/wangp";
import type { Project } from "@/lib/schemas/project";

/** Minimal preferences the router needs (avoids requiring a full Project). */
export type ModelPreference = { modelStrategy: Project["modelStrategy"] };

/** Convert a discovered WanGP model into capability tags (spec Section 2A.8). */
export function toCapability(model: WangpModel): ModelCapability {
  const image = model.metadata.mediaInputs?.image;
  return {
    modelType: model.modelType,
    provider: "wangp",
    outputs: [model.metadata.mainOutput],
    inputs: model.metadata.inputs,
    supportsStartFrame: Boolean(image?.start),
    supportsEndFrame: Boolean(image?.end),
    supportsReferenceImages: Boolean(image?.reference),
    supportsLora: Boolean(model.metadata.supportsLora),
    maxFrames: model.metadata.maxFrames,
    recommendedFps: model.metadata.recommendedFps,
    vramProfile: model.metadata.vramProfile,
    qualityRank: model.metadata.qualityRank,
  };
}

function strategyBonus(modelType: string, strategy: Project["modelStrategy"]): number {
  switch (strategy) {
    case "prefer_wan":
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
 * Rank video models for scene continuity: prefer image start-frame support, then
 * the project's model strategy, then quality rank (spec Section 11.3).
 */
export function rankVideoModels(models: WangpModel[], project: ModelPreference): WangpModel[] {
  return [...models]
    .filter((m) => m.metadata.mainOutput === "video")
    .map((m) => ({ model: m, cap: toCapability(m) }))
    .sort((a, b) => {
      const startA = a.cap.supportsStartFrame ? 1000 : 0;
      const startB = b.cap.supportsStartFrame ? 1000 : 0;
      const scoreA = startA + strategyBonus(a.model.modelType, project.modelStrategy) + (a.cap.qualityRank ?? 0);
      const scoreB = startB + strategyBonus(b.model.modelType, project.modelStrategy) + (b.cap.qualityRank ?? 0);
      return scoreB - scoreA;
    })
    .map((entry) => entry.model);
}

export function selectVideoModel(models: WangpModel[], project: ModelPreference): WangpModel | null {
  const ranked = rankVideoModels(models, project);
  return ranked[0] ?? null;
}

export function selectImageModel(models: WangpModel[], project: ModelPreference): WangpModel | null {
  const images = models
    .filter((m) => m.metadata.mainOutput === "image")
    .sort(
      (a, b) =>
        strategyBonus(b.modelType, project.modelStrategy) - strategyBonus(a.modelType, project.modelStrategy) ||
        (b.metadata.qualityRank ?? 0) - (a.metadata.qualityRank ?? 0),
    );
  return images[0] ?? null;
}
