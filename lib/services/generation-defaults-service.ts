import { config } from "@/lib/config";
import { generationDefaultsStore } from "@/lib/db/generation-defaults-store";
import { pruneSelectionSet, resolvePinnedModels } from "@/lib/services/lora-service";
import {
  generationDefaultsSchema,
  updateGenerationDefaultsSchema,
  type GenerationDefaults,
} from "@/lib/schemas/generation-defaults";
import type { LoraSelectionSet } from "@/lib/schemas/lora";
import { logEvent } from "@/lib/telemetry";

/** The saved defaults, or empty ones on a fresh install. */
export async function getGenerationDefaults(): Promise<GenerationDefaults> {
  return generationDefaultsStore.get();
}

/**
 * Replace the defaults.
 *
 * Stored as given rather than validated against a live catalogue: WanGP may be
 * down, or a model may not be installed on the machine doing the configuring,
 * and neither should stop someone writing down what they want. What a selection
 * is actually worth is decided when a project lands on a model, which is where
 * the check belongs.
 */
export async function saveGenerationDefaults(raw: unknown): Promise<GenerationDefaults> {
  const patch = updateGenerationDefaultsSchema.parse(raw);
  const current = await generationDefaultsStore.get();

  const next = generationDefaultsSchema.parse({
    ...current,
    version: 1,
    // Empty string clears a pin; undefined leaves it alone.
    ...("imageModel" in patch ? { imageModel: patch.imageModel || undefined } : {}),
    ...("videoModel" in patch ? { videoModel: patch.videoModel || undefined } : {}),
    ...("imageSteps" in patch ? { imageSteps: patch.imageSteps || undefined } : {}),
    ...("videoSteps" in patch ? { videoSteps: patch.videoSteps || undefined } : {}),
    ...(patch.loras ? { loras: patch.loras } : {}),
    updatedAt: new Date().toISOString(),
  });

  const saved = await generationDefaultsStore.save(next);
  logEvent("settings.generation_defaults_saved", {
    imageModel: saved.imageModel ?? null,
    videoModel: saved.videoModel ?? null,
    imageLoras: saved.loras.image.length,
    videoLoras: saved.loras.video.length,
  });
  return saved;
}

/** What a newly created project inherits, once the pins are settled. */
export type InheritedGeneration = {
  imageModel?: string;
  videoModel?: string;
  imageSteps?: number;
  videoSteps?: number;
  loras?: LoraSelectionSet;
};

/**
 * The generation settings a new project should start with.
 *
 * Precedence is explicit choice, then these defaults, then the environment pin.
 * A value typed on the New Project form is a decision about *this* project and
 * outranks a standing preference; the environment is the oldest and weakest,
 * since it cannot be changed without a restart.
 *
 * The LoRA stack is pruned against whichever models the project actually lands
 * on. Carrying it over unchecked is the failure worth avoiding: a stack chosen
 * for the default image model would otherwise ride onto a project pinned to a
 * different one, where the names resolve to nothing and the first render is
 * quietly not the render that was configured. A catalogue that cannot be read
 * leaves the selection alone rather than discarding it — an unreachable WanGP
 * is not evidence that a LoRA is wrong.
 */
export async function inheritedGeneration(explicit: {
  imageModel?: string;
  videoModel?: string;
}): Promise<InheritedGeneration> {
  const defaults = await generationDefaultsStore.get();

  const imageModel = explicit.imageModel ?? defaults.imageModel ?? config.defaults.imageModel ?? undefined;
  const videoModel = explicit.videoModel ?? defaults.videoModel ?? undefined;

  const inherited: InheritedGeneration = {
    imageModel,
    videoModel,
    imageSteps: defaults.imageSteps,
    videoSteps: defaults.videoSteps,
  };

  const wanted = defaults.loras;
  if (!wanted.image.length && !wanted.video.length) return inherited;

  try {
    const models = await resolvePinnedModels({ imageModel, videoModel });
    inherited.loras = await pruneSelectionSet(wanted, models, { projectId: "new" });
  } catch {
    logEvent("settings.generation_defaults_loras_unchecked", {
      reason: "catalog_unavailable",
      image: wanted.image.length,
      video: wanted.video.length,
    });
    inherited.loras = wanted;
  }

  return inherited;
}
