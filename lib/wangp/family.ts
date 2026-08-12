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
 *
 * MiniMax H3 is split because its two variants share a lineage and almost
 * nothing else. `minimax` is the keyframe side — FL2VA and its one-ended
 * relatives — which takes `image_start` / `image_end` positionally, supports
 * sliding windows and accepts accelerator LoRAs. `minimax_ref2va` takes
 * `image_refs` instead, supports sliding-window continuation but is destroyed
 * by the same accelerator. A single family value would have to be wrong about
 * one of them at every decision point.
 */
export type ModelFamily =
  | "flux"
  | "qwen"
  | "wan"
  | "ltx"
  | "krea"
  | "minimax"
  | "minimax_ref2va"
  | "unknown";

/** Both H3 variants, for the traits the lineage really does share. */
export function isMinimaxFamily(family: ModelFamily): boolean {
  return family === "minimax" || family === "minimax_ref2va";
}

const FAMILY_LABELS: Record<ModelFamily, string> = {
  flux: "FLUX",
  qwen: "Qwen",
  wan: "Wan",
  ltx: "LTX",
  krea: "Krea",
  minimax: "MiniMax H3, first and last frame",
  minimax_ref2va: "MiniMax H3, reference mode",
  unknown: "an unrecognised model",
};

/** How a family is named to the user. */
export function familyLabel(family: string | undefined): string {
  return FAMILY_LABELS[(family ?? "unknown") as ModelFamily] ?? "an unrecognised model";
}

/** Longest tokens first, so `ltxv` is not mistaken for something shorter. */
const FAMILY_TOKENS: ReadonlyArray<readonly [ModelFamily, readonly string[]]> = [
  ["flux", ["flux"]],
  ["qwen", ["qwen"]],
  ["ltx", ["ltxv", "ltx"]],
  ["wan", ["wan"]],
  ["krea", ["krea"]],
  ["minimax", ["minimax", "_h3_"]],
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
    if (!tokens.some((token) => haystack.includes(token))) continue;
    // Anchored to the H3 lineage rather than matched on its own, so a `ref2va`
    // appearing in some unrelated checkpoint name cannot claim the variant.
    return family === "minimax" && haystack.includes("ref2va") ? "minimax_ref2va" : family;
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
 * MiniMax H3 is here on direct evidence rather than documentation: a live WanGP
 * schema dump of `minimax_h3_fl2va` declares no `negative_prompt` field, so
 * `setIf` drops it and every exclusion was being discarded in silence.
 *
 * `unknown` keeps the negative prompt: WanGP only sets fields a model's schema
 * declares, so an unrecognised model that has no negative field ignores it
 * harmlessly, whereas dropping it from one that does would lose the constraint.
 */
export function supportsNegativePrompt(family: ModelFamily): boolean {
  return family !== "flux" && family !== "krea" && !isMinimaxFamily(family);
}
