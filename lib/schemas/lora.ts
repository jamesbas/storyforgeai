import { z } from "zod";

/**
 * Stacked LoRAs each cost VRAM on a card already tight at 16 GB, and past a
 * handful they fight each other rather than compose. Eight is a ceiling, not a
 * target.
 */
export const MAX_LORAS_PER_MODEL = 8;

/**
 * One selected LoRA.
 *
 * `name` is a bare filename as it appears in WanGP's `loras/<family>` folder —
 * never a path. WanGP resolves it relative to the model family's directory, so
 * a separator or dot segment here would be both meaningless and a traversal
 * risk once it reaches the filesystem catalog.
 */
export const loraSelectionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !n.includes("/") && !n.includes("\\"), {
      message: "LoRA name must be a bare filename, not a path",
    })
    .refine((n) => !n.split(/[\\/]/).includes("..") && !n.startsWith("."), {
      message: "LoRA name must not be a dot segment",
    }),
  /**
   * WanGP `loras_multipliers` value for this LoRA. Negative weights invert a
   * LoRA's effect and are occasionally useful, hence the signed range.
   */
  strength: z.number().min(-10).max(10).default(1),
});
export type LoraSelection = z.infer<typeof loraSelectionSchema>;

/**
 * LoRAs are keyed by the kind of model they apply to, because a project pins an
 * image model and a video model independently and their catalogs are disjoint —
 * an LTX-2 motion LoRA is meaningless to Flux.
 */
export const loraSelectionSetSchema = z.object({
  image: z.array(loraSelectionSchema).max(MAX_LORAS_PER_MODEL).default([]),
  video: z.array(loraSelectionSchema).max(MAX_LORAS_PER_MODEL).default([]),
});
export type LoraSelectionSet = z.infer<typeof loraSelectionSetSchema>;

export const LORA_SCENE_MODES = ["inherit", "override"] as const;
export type LoraSceneMode = (typeof LORA_SCENE_MODES)[number];

/**
 * A scene's departure from the storyboard-wide selection.
 *
 * `override` replaces the project selection outright rather than merging with
 * it. Merging is tempting — a global look LoRA plus a per-scene action LoRA is a
 * natural pattern — but it silently pushes the stack toward the count ceiling
 * and compounds weights the user never chose together.
 */
export const sceneLoraOverrideSchema = z.object({
  mode: z.enum(LORA_SCENE_MODES).default("inherit"),
  image: z.array(loraSelectionSchema).max(MAX_LORAS_PER_MODEL).default([]),
  video: z.array(loraSelectionSchema).max(MAX_LORAS_PER_MODEL).default([]),
});
export type SceneLoraOverride = z.infer<typeof sceneLoraOverrideSchema>;

/** Per-scene overrides, keyed by scene id. */
export const sceneLoraMapSchema = z.record(sceneLoraOverrideSchema);
export type SceneLoraMap = z.infer<typeof sceneLoraMapSchema>;

/** Which pinned model a catalog request refers to. */
export const LORA_KINDS = ["image", "video"] as const;
export type LoraKind = (typeof LORA_KINDS)[number];

/** One installed LoRA, as offered to the picker. */
export type LoraCatalogEntry = {
  /** Bare filename, and the value sent to WanGP in `activated_loras`. */
  name: string;
  /**
   * Human-readable label from the LoRA Manager sidecar, falling back to the
   * filename. Many installed LoRAs have opaque hash-like filenames, so without
   * this the picker is unusable.
   */
  label: string;
  /**
   * Words the LoRA was trained against. Several LoRAs do nothing at all unless
   * one appears in the prompt, so this is surfaced as a hint rather than hidden.
   */
  triggerWords: string[];
  sizeMb?: number;
};

/**
 * Discriminated so the UI can explain *why* a picker is empty — model has no
 * LoRA support, root not configured, directory absent — instead of rendering a
 * blank list that looks broken.
 */
export type LoraCatalog =
  | { supported: true; modelType: string; directory: string; loras: LoraCatalogEntry[] }
  | { supported: false; modelType: string; reason: string };
