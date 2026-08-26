import { z } from "zod";
import { loraSelectionSetSchema } from "@/lib/schemas/lora";

/**
 * App-wide starting point for a new project's generation settings.
 *
 * A project pins its own models, LoRAs and step counts, and always has. What
 * this saves is setting them again for every project — a LoRA stack in
 * particular is a dozen deliberate choices, each with a strength and a trigger
 * word, and rebuilding it by hand each time is the tax this removes.
 *
 * Read once at creation and copied onto the project. Deliberately not consulted
 * afterwards: a project that has been created owns its settings outright, so
 * changing these can never reach back and re-pin work already under way.
 */
export const generationDefaultsSchema = z.object({
  version: z.literal(1),
  /** Empty means "no default": the project falls back to the env pin, then automatic. */
  imageModel: z.string().optional(),
  videoModel: z.string().optional(),
  imageSteps: z.number().int().min(1).max(200).optional(),
  videoSteps: z.number().int().min(1).max(200).optional(),
  /**
   * Only meaningful against the models above, since a catalogue is per model
   * family — an LTX-2 motion LoRA means nothing to Flux. Stored as chosen and
   * checked against whichever model a new project actually lands on.
   */
  loras: loraSelectionSetSchema.default({ image: [], video: [] }),
  updatedAt: z.string(),
});

export type GenerationDefaults = z.infer<typeof generationDefaultsSchema>;

/** What a fresh install has: nothing pinned, nothing selected. */
export function emptyGenerationDefaults(): GenerationDefaults {
  return {
    version: 1,
    loras: { image: [], video: [] },
    updatedAt: new Date().toISOString(),
  };
}

/** The editable half, as the settings screen sends it. */
export const updateGenerationDefaultsSchema = generationDefaultsSchema
  .pick({
    imageModel: true,
    videoModel: true,
    imageSteps: true,
    videoSteps: true,
    loras: true,
  })
  .partial();

export type UpdateGenerationDefaultsInput = z.infer<typeof updateGenerationDefaultsSchema>;
