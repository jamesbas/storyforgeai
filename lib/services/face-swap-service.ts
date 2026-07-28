import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { getWangpClient } from "@/lib/wangp/factory";
import { findPinned } from "@/lib/wangp/model-router";
import {
  FACE_SWAP_PROMPT,
  FACE_SWAP_SETTINGS,
} from "@/lib/wangp/face-swap-preset";
import { referenceImagesOf, wantsFaceSwap } from "@/lib/schemas/character";
import { resolveReferenceImagePath } from "@/lib/db/character-store";
import type { Character } from "@/lib/schemas/character";

/**
 * Face swap as a post-process on a rendered keyframe.
 *
 * Reference conditioning gets identity close; it does not get it exact, because
 * the base model is still synthesising a face rather than transplanting one.
 * This runs a dedicated Qwen Image Edit pass that replaces the head in a
 * generated frame with the head from the character's reference photo.
 *
 * It is deliberately *not* a background job. The end frame is rendered against
 * the start frame, and the clip is rendered from both, so a swap that landed
 * afterwards would be overwritten by the very frames it was meant to correct.
 * The swap has to sit between renders, which makes it a synchronous step.
 *
 * The whole pass is four Lightning steps — seconds, not the minutes a keyframe
 * costs — so the ordering constraint is cheap to honour.
 */

/**
 * The single character a swap should target, if there is one.
 *
 * The preset's prompt names "the woman" in each picture, so it assumes exactly
 * one subject. With two opted-in characters there is no way to say which face
 * belongs where, and swapping the wrong one is worse than not swapping, so the
 * scene is left alone and the reason is logged.
 */
export function faceSwapSubject(cast: readonly Character[]): Character | null {
  if (!config.media.faceSwapEnabled) return null;
  const candidates = cast.filter((character) => wantsFaceSwap(character));
  if (candidates.length === 1) return candidates[0]!;

  if (candidates.length > 1) {
    logEvent("face_swap.skipped", {
      reason: "multiple_characters_opted_in",
      characters: candidates.map((c) => c.name),
    });
  }
  return null;
}

/**
 * Swap the face in `imagePath`, returning the new image, or null when the swap
 * could not run.
 *
 * Null rather than throwing: a failed swap should cost the improvement, not the
 * scene. The caller keeps the original frame and the reason is logged.
 */
export async function swapFace(
  imagePath: string,
  character: Character,
  context: { sceneId: string; purpose: string },
): Promise<string | null> {
  const references = referenceImagesOf(character);
  const reference = references[0];
  if (!reference) return null;

  /*
   * Only the first reference is used, and that is a property of the prompt
   * rather than a known limit of the model.
   *
   * The preset addresses "Picture 1" (the guide image) and "Picture 2" (the
   * reference) by position. Passing a second reference would put three images in
   * front of a prompt that names two, leaving the third unaddressed — which is
   * more likely to dilute the swap than improve it. Using both would mean
   * rewriting the prompt to name Picture 3 too, which has not been tested.
   *
   * Logged rather than dropped quietly: a character set up with two photos would
   * otherwise give no clue that the swap only ever saw one.
   */
  if (references.length > 1) {
    logEvent("face_swap.reference_ignored", {
      ...context,
      character: character.name,
      used: reference,
      ignored: references.slice(1),
    });
  }

  const referencePath = resolveReferenceImagePath(reference);
  if (!referencePath) return null;

  try {
    const client = getWangpClient();
    const images = await client.listModels("image");
    const model = findPinned(images, config.media.faceSwapModel);
    if (!model) {
      logEvent("face_swap.skipped", {
        ...context,
        reason: "model_not_installed",
        model: config.media.faceSwapModel,
      });
      return null;
    }

    const schema = await client.getModelSchema(model.modelType);
    const settings: Record<string, unknown> = {
      ...schema.defaultSettings,
      ...FACE_SWAP_SETTINGS,
      prompt: FACE_SWAP_PROMPT,
      // Picture 1 is the frame being corrected; Picture 2 is the face to apply.
      image_guide: imagePath,
      image_refs: [referencePath],
      model_type: model.modelType,
    };

    const job = await client.generate(settings);
    const finished = await pollToCompletion(job.id);
    const output = finished.generatedFiles[0];

    if (!output) {
      logEvent("face_swap.skipped", { ...context, reason: "no_output", errors: finished.errors });
      return null;
    }

    logEvent("face_swap.applied", { ...context, character: character.name, model: model.modelType });
    return output;
  } catch (err) {
    // A swap is an enhancement. Losing it must not lose the frame.
    logEvent("face_swap.skipped", {
      ...context,
      reason: "request_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function pollToCompletion(jobId: string) {
  const client = getWangpClient();
  const live = client.mode === "live";
  const attempts = live ? config.wangp.maxPollAttempts : 10;
  const intervalMs = live ? config.wangp.pollIntervalMs : 0;

  for (let i = 0; i < attempts; i += 1) {
    const job = await client.getJob(jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { id: jobId, status: "failed" as const, progress: 0, generatedFiles: [], errors: ["timed out"] };
}
