import { familyOf, isMinimaxFamily, type ModelFamily } from "@/lib/wangp/family";

/**
 * Whether a storyboard's clip prompts were written for the model it now uses.
 *
 * A clip prompt is not portable between families and the mismatch is silent:
 * an LTX prompt renders perfectly well on MiniMax H3, it is simply a third of
 * the length H3 is built to consume and uses camera words H3 does not know. The
 * clip comes back worse and nothing says why, so the storyboard has to notice.
 *
 * Judged one scene at a time, because a storyboard is rarely all one thing.
 * Scenes get rewritten individually, a run can fail partway, and a model can be
 * changed between two sittings — so asking only whether *any* scene looks
 * current would let a mostly stale storyboard pass on the strength of its best
 * scene.
 */

export type PromptFamilyCheck = {
  /** What the stale prompts were written for, when that can be established. */
  writtenFor: string;
  /** Whether the answer came from a recorded stamp or was inferred. */
  certainty: "stamped" | "inferred";
  /** How many scenes disagree with the pinned model, out of how many. */
  staleScenes: number;
  totalScenes: number;
};

type PromptLike = {
  videoSoundscape?: string;
  videoScore?: string;
  videoPromptFamily?: string;
};

/**
 * The prompt fields that identify their own author.
 *
 * Ambience and score are requested as separate fields by exactly one branch of
 * the video directive — MiniMax H3's, the only family asked to keep them out of
 * the prose. Either one will do: a scene can legitimately carry no score, so
 * requiring both would call a silent shot stale.
 */
function looksWrittenForH3(prompts: PromptLike): boolean {
  return Boolean(prompts.videoSoundscape?.trim() || prompts.videoScore?.trim());
}

/** A stamp is evidence; without one, the audio fields are the tell. */
function isStale(prompts: PromptLike, current: ModelFamily): boolean {
  if (prompts.videoPromptFamily) return prompts.videoPromptFamily !== current;
  return isMinimaxFamily(current) !== looksWrittenForH3(prompts);
}

export function checkPromptFamily(args: {
  /** The project's pinned video model. Unpinned falls through to the router. */
  videoModel: string | undefined;
  scenes: readonly { prompts: PromptLike }[];
}): PromptFamilyCheck | null {
  // No pin, no claim: an unpinned project resolves at render time, so there is
  // no family for the prompts to disagree with.
  if (!args.videoModel || !args.scenes.length) return null;
  const current = familyOf(args.videoModel);
  if (current === "unknown") return null;

  const stale = args.scenes.filter((scene) => isStale(scene.prompts, current));
  if (!stale.length) return null;

  const stamped = stale
    .map((scene) => scene.prompts.videoPromptFamily)
    .find((family): family is string => Boolean(family));

  return {
    writtenFor:
      stamped ?? (isMinimaxFamily(current) ? "another model" : ("minimax" satisfies ModelFamily)),
    certainty: stamped ? "stamped" : "inferred",
    staleScenes: stale.length,
    totalScenes: args.scenes.length,
  };
}
