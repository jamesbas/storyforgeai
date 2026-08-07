import { familyOf, isMinimaxFamily, type ModelFamily } from "@/lib/wangp/family";

/**
 * Whether a storyboard's clip prompts were written for the model it now uses.
 *
 * A clip prompt is not portable between families and the mismatch is silent:
 * an LTX prompt renders perfectly well on MiniMax H3, it is simply a third of
 * the length H3 is built to consume and uses camera words H3 does not know. The
 * clip comes back worse and nothing says why, so the storyboard has to notice.
 */

export type PromptFamilyCheck = {
  /** What the prompts were written for, when that can be established. */
  writtenFor: string;
  /** Whether the answer came from a recorded stamp or was inferred. */
  certainty: "stamped" | "inferred";
};

/**
 * The one prompt field that identifies its own author.
 *
 * `videoSoundscape` is requested by exactly one branch of the video directive —
 * MiniMax H3's, which is the only family asked to return ambience and score as
 * fields rather than folding them into the prose. So its presence or absence
 * says which side of that line a prompt was written on, which is enough to
 * catch a storyboard that predates the stamp.
 */
function looksWrittenForH3(scenes: readonly { prompts: { videoSoundscape?: string } }[]): boolean {
  return scenes.some((scene) => Boolean(scene.prompts.videoSoundscape?.trim()));
}

export function checkPromptFamily(args: {
  /** The project's pinned video model. Unpinned falls through to the router. */
  videoModel: string | undefined;
  scenes: readonly { prompts: { videoSoundscape?: string; videoPromptFamily?: string } }[];
}): PromptFamilyCheck | null {
  // No pin, no claim: an unpinned project resolves at render time, so there is
  // no family for the prompts to disagree with.
  if (!args.videoModel || !args.scenes.length) return null;
  const current = familyOf(args.videoModel);
  if (current === "unknown") return null;

  const stamped = args.scenes
    .map((scene) => scene.prompts.videoPromptFamily)
    .find((family): family is string => Boolean(family));

  if (stamped) {
    return stamped === current ? null : { writtenFor: stamped, certainty: "stamped" };
  }

  // Unstamped: written before the stamp existed. Inferring is worth doing
  // because this is exactly the storyboard most likely to be stale — it was
  // written under an older release and has since outlived a model change.
  const wroteForH3 = looksWrittenForH3(args.scenes);
  if (isMinimaxFamily(current) && !wroteForH3) {
    return { writtenFor: "another model", certainty: "inferred" };
  }
  if (!isMinimaxFamily(current) && wroteForH3) {
    return { writtenFor: "minimax" satisfies ModelFamily, certainty: "inferred" };
  }
  return null;
}
