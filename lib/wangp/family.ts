import type { WangpModel } from "@/lib/schemas/wangp";

/**
 * Which model lineage a checkpoint belongs to.
 *
 * The families differ in ways a prompt has to respect. Black Forest Labs states
 * plainly that FLUX has no conventional negative prompting, so an exclusion sent
 * as a negative prompt is discarded; Qwen ships an official negative prompt in
 * its own Diffusers example; Wan asks for motion and camera and little else;
 * LTX generates audio from the same prompt that drives the picture. Sending one
 * undifferentiated prompt to all of them means writing for none of them.
 */
export type ModelFamily = "flux" | "qwen" | "wan" | "ltx" | "krea" | "unknown";

/** Longest tokens first, so `ltxv` is not mistaken for something shorter. */
const FAMILY_TOKENS: ReadonlyArray<readonly [ModelFamily, readonly string[]]> = [
  ["flux", ["flux"]],
  ["qwen", ["qwen"]],
  ["ltx", ["ltxv", "ltx"]],
  ["wan", ["wan"]],
  ["krea", ["krea"]],
];

/**
 * Identify a family from WanGP's own metadata, falling back to the model type.
 *
 * WanGP reports `metadata.family` for the models that have one, but it names
 * the LoRA directory rather than the lineage (`ltx2_22B` variants report
 * `ltx2`), so both strings are searched.
 */
export function familyOf(modelType: string | undefined, declared?: string): ModelFamily {
  const haystack = `${declared ?? ""} ${modelType ?? ""}`.toLocaleLowerCase();
  for (const [family, tokens] of FAMILY_TOKENS) {
    if (tokens.some((token) => haystack.includes(token))) return family;
  }
  return "unknown";
}

export function familyOfModel(model: Pick<WangpModel, "modelType" | "metadata">): ModelFamily {
  return familyOf(model.modelType, model.metadata.family);
}

/**
 * Whether a negative prompt reaches the render at all.
 *
 * FLUX is the documented exception: BFL's guidance is to describe the desired
 * alternative positively instead. Krea's hosted and open workflows do not
 * consistently expose negative conditioning either, so it is treated the same
 * way — the exclusion still travels, but as a positive constraint.
 *
 * `unknown` keeps the negative prompt: WanGP only sets fields a model's schema
 * declares, so an unrecognised model that has no negative field ignores it
 * harmlessly, whereas dropping it from one that does would lose the constraint.
 */
export function supportsNegativePrompt(family: ModelFamily): boolean {
  return family !== "flux" && family !== "krea";
}
