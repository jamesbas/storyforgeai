import path from "node:path";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import { getWangpClient } from "@/lib/wangp/factory";
import { findPinned } from "@/lib/wangp/model-router";
import { getLoraCatalog, resetLoraCatalogCache } from "@/lib/wangp/lora-catalog";
import { effectiveTriggerWords, needsTriggerChoice } from "@/lib/lora/trigger-words";
import type { LoraModelIdentity } from "@/lib/wangp/lora-catalog";
import type {
  LoraCatalog,
  LoraKind,
  LoraSelection,
  LoraSelectionSet,
  SceneLoraMap,
} from "@/lib/schemas/lora";
import type { Project } from "@/lib/schemas/project";
import type { WangpModel } from "@/lib/schemas/wangp";

export { resetLoraCatalogCache };

/**
 * WanGP keeps sidecar records in a `loras_metadata` folder beside `loras`, so
 * configuring the LoRA root alone is enough for labels and trigger words.
 */
export function resolveLoraMetadataRoot(): string {
  if (config.wangp.loraMetadataRoot) return config.wangp.loraMetadataRoot;
  if (!config.wangp.loraRoot) return "";
  return path.join(path.dirname(path.resolve(config.wangp.loraRoot)), "loras_metadata");
}

export function identityOf(model: WangpModel): LoraModelIdentity {
  return {
    modelType: model.modelType,
    family: model.metadata.family,
    baseModelType: model.metadata.baseModelType,
    supportsLora: model.metadata.supportsLora,
  };
}

/** Catalog for an already-resolved model. */
export async function catalogForModel(model: WangpModel): Promise<LoraCatalog> {
  return getLoraCatalog(config.wangp.loraRoot, resolveLoraMetadataRoot(), identityOf(model));
}

/**
 * Catalog for a model type, looked up through discovery so family metadata is
 * available. Used by the API route backing the picker.
 */
export async function catalogForModelType(modelType: string): Promise<LoraCatalog> {
  const models = await getWangpClient().listModels();
  const model = models.find((m) => m.modelType === modelType);
  if (!model) {
    return { supported: false, modelType, reason: `Unknown model '${modelType}'.` };
  }
  return catalogForModel(model);
}

/**
 * The LoRAs that apply to a scene.
 *
 * Re-exported from a dependency-free module so the browser can apply the same
 * rule when previewing which trigger words a scene will receive.
 */
export { resolveSceneLoras } from "@/lib/lora/scene-selection";

/**
 * Strict check used when a selection is saved: every name must exist in the
 * catalog. Returns the selection with names canonicalised to their on-disk
 * spelling so a case difference cannot reach WanGP.
 */
export function validateLoras(selected: LoraSelection[], catalog: LoraCatalog): LoraSelection[] {
  if (!selected.length) return [];
  if (!catalog.supported) throw new ValidationError(catalog.reason);

  const available = new Map(catalog.loras.map((entry) => [entry.name.toLocaleLowerCase(), entry.name]));
  return selected.map((selection) => {
    const canonical = available.get(selection.name.toLocaleLowerCase());
    if (!canonical) {
      throw new ValidationError(
        `LoRA '${selection.name}' is not installed for ${catalog.modelType}. ` +
          `Choose one of the LoRAs listed for this model, or clear the selection.`,
      );
    }
    return { ...selection, name: canonical };
  });
}

/**
 * A selection paired with the trigger words it will actually contribute.
 *
 * `triggerWords` is the *effective* set — what goes into the prompt — which for
 * a multi-concept LoRA is a chosen subset of what the file offers rather than
 * all of it. `availableTriggerWords` carries the full list so callers can show
 * the choice without a second catalog read.
 */
export type ResolvedLora = LoraSelection & {
  triggerWords: string[];
  availableTriggerWords: string[];
};

/**
 * Lenient check used at generation time.
 *
 * The model actually used can differ from the one a selection was made against
 * — `buildImageManifest` substitutes a reference-capable model when a scene
 * pins characters — which would strand LoRAs that are perfectly valid for the
 * pinned model. Failing scene 7 of a 20-scene batch over that is worse than
 * rendering it without the LoRA, so incompatible entries are dropped and
 * logged rather than thrown.
 */
export function reconcileLoras(
  selected: LoraSelection[],
  catalog: LoraCatalog,
  context: { sceneId: string; modelType: string; kind: LoraKind },
): ResolvedLora[] {
  if (!selected.length) return [];

  if (!catalog.supported) {
    logEvent("lora.dropped", {
      ...context,
      dropped: selected.map((s) => s.name),
      reason: catalog.reason,
    });
    return [];
  }

  const available = new Map(catalog.loras.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
  const kept: ResolvedLora[] = [];
  const dropped: string[] = [];
  const undecided: string[] = [];

  for (const selection of selected) {
    const entry = available.get(selection.name.toLocaleLowerCase());
    if (!entry) {
      dropped.push(selection.name);
      continue;
    }

    if (needsTriggerChoice(selection.triggerWords, entry.triggerWords)) undecided.push(entry.name);

    kept.push({
      ...selection,
      name: entry.name,
      triggerWords: effectiveTriggerWords(selection.triggerWords, entry.triggerWords),
      availableTriggerWords: entry.triggerWords,
    });
  }

  if (dropped.length) {
    logEvent("lora.dropped", {
      ...context,
      dropped,
      reason: "not_installed_for_resolved_model",
    });
  }

  // A multi-concept LoRA with no trigger chosen still loads, but does nothing
  // useful. Worth saying so rather than leaving the user to wonder.
  if (undecided.length) {
    logEvent("lora.dropped", {
      ...context,
      dropped: undecided,
      reason: "no_trigger_word_chosen",
    });
  }

  return kept;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trigger words from a resolved stack that the prompt does not already contain. */
export function missingTriggerWords(
  prompt: string,
  loras: readonly ResolvedLora[],
): string[] {
  const words = [
    ...new Set(
      loras
        .flatMap((lora) => lora.triggerWords)
        .map((word) => word.trim())
        .filter(Boolean),
    ),
  ];

  // Word boundaries rather than substring matching, so a trigger word of "cat"
  // is not considered present because the prompt says "concatenate". Multi-word
  // phrases still work; the escape keeps regex characters literal.
  return words.filter((word) => !new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(prompt));
}

/**
 * Append any trigger words the prompt is missing.
 *
 * Several LoRAs do nothing at all unless a trigger word appears in the prompt,
 * which makes "selected a LoRA, saw no difference" the most common way to think
 * a LoRA is broken when it is merely dormant. Appending only what is absent
 * means a hand-written prompt that already names the trigger is left alone, and
 * editing a prompt never produces duplicates.
 */
export function appendTriggerWords(prompt: string, loras: readonly ResolvedLora[]): string {
  const missing = missingTriggerWords(prompt, loras);
  if (!missing.length) return prompt;
  const separator = /[.,;\s]$/.test(prompt) ? " " : ", ";
  return `${prompt}${separator}${missing.join(", ")}`;
}

/** Validate an entire selection set against the models it will be used with. */
export async function validateSelectionSet(
  set: LoraSelectionSet,
  models: { image?: WangpModel; video?: WangpModel },
): Promise<LoraSelectionSet> {
  const result: LoraSelectionSet = { image: [], video: [] };

  for (const kind of ["image", "video"] as const) {
    const selection = set[kind] ?? [];
    if (!selection.length) continue;
    const model = models[kind];
    if (!model) {
      throw new ValidationError(
        `Cannot verify ${kind} LoRAs because no ${kind} model is resolved for this project.`,
      );
    }
    result[kind] = validateLoras(selection, await catalogForModel(model));
  }

  return result;
}

/**
 * Best-effort cleanup after a model pin changes.
 *
 * Selections made against the old model are usually meaningless to the new one,
 * but rejecting the *model change* because of them would be backwards — the
 * user asked to change the model. Incompatible entries are dropped and logged.
 */
export async function pruneSelectionSet(
  set: LoraSelectionSet,
  models: { image?: WangpModel; video?: WangpModel },
  context: { projectId: string },
): Promise<LoraSelectionSet> {
  const result: LoraSelectionSet = { image: [], video: [] };

  for (const kind of ["image", "video"] as const) {
    const selection = set[kind] ?? [];
    if (!selection.length) continue;
    const model = models[kind];
    if (!model) {
      logEvent("lora.dropped", {
        sceneId: "-",
        modelType: "-",
        kind,
        dropped: selection.map((s) => s.name),
        reason: "no_model_resolved_after_pin_change",
      });
      continue;
    }
    result[kind] = reconcileLoras(selection, await catalogForModel(model), {
      sceneId: `project:${context.projectId}`,
      modelType: model.modelType,
      kind,
    });
  }

  return result;
}

/**
 * Resolve the models a project's pins currently point at, so a selection can be
 * checked against them. Returns undefined for a kind with no usable pin, where
 * the router would choose at generation time and there is nothing to check.
 */
export async function resolvePinnedModels(pins: {
  imageModel?: string;
  videoModel?: string;
}): Promise<{ image?: WangpModel; video?: WangpModel }> {
  const client = getWangpClient();
  const [imageModels, videoModels] = await Promise.all([
    client.listModels("image"),
    client.listModels("video"),
  ]);
  return {
    image: findPinned(imageModels, pins.imageModel || config.wangp.imageModel) ?? undefined,
    video: findPinned(videoModels, pins.videoModel || config.wangp.videoModel) ?? undefined,
  };
}

/**
 * Drop overrides for scenes that no longer exist. Scene ids change when a
 * storyboard is regenerated, so without this the map accumulates entries that
 * can never apply.
 */
export function pruneSceneLoras(
  sceneLoras: SceneLoraMap | undefined,
  sceneIds: string[],
): SceneLoraMap | undefined {
  if (!sceneLoras) return undefined;
  const live = new Set(sceneIds);
  const kept = Object.entries(sceneLoras).filter(([sceneId]) => live.has(sceneId));
  if (kept.length === Object.keys(sceneLoras).length) return sceneLoras;
  return kept.length ? Object.fromEntries(kept) : undefined;
}
