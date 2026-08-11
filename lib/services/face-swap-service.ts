import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { getWangpClient } from "@/lib/wangp/factory";
import { findPinned } from "@/lib/wangp/model-router";
import {
  FACE_SWAP_PROMPT,
  FACE_SWAP_SETTINGS,
} from "@/lib/wangp/face-swap-preset";
import { referenceImagesOf, wantsFaceSwap } from "@/lib/schemas/character";
import { isUndressed, positiveGarments } from "@/lib/agents/wardrobe";
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
 * Every character a swap should target, in a stable order.
 *
 * One pass runs per character, each with its own prompt, so a frame holding two
 * named people gets both faces corrected. Ordered by id rather than by cast or
 * scene position: the passes chain, so the order decides the result, and a
 * re-run of the same batch has to produce the same chain.
 */
export function faceSwapSubjects(cast: readonly Character[]): Character[] {
  if (!config.media.faceSwapEnabled) return [];
  return cast.filter((character) => wantsFaceSwap(character)).sort((a, b) => a.id.localeCompare(b.id));
}

/** One person the frame shows, as the swap needs to tell them apart. */
export type FramePerson = { wardrobe?: string; description?: string };

/** "completely naked" or "dressed in a white polo shirt", from a wardrobe. */
function wardrobePhrase(wardrobe: string | undefined): string | undefined {
  const text = wardrobe?.trim();
  if (!text) return undefined;
  return isUndressed(text) ? "completely naked" : `dressed in ${positiveGarments(text)}`;
}

/** Words that sit in front of "hair" without describing it. */
const NOT_A_HAIR_WORD = /^(?:with|and|her|his|their|the|a|an|of|in|has|have|long|short|medium)$/i;

/** The hair colour out of a description, as a last resort for telling two nudes apart. */
function hairToken(description: string | undefined): string | undefined {
  const run = description?.match(/((?:[a-z-]+\s+){1,4})hair\b/i);
  if (!run) return undefined;
  const colour = run[1]!
    .trim()
    .split(/\s+/)
    .find((word) => !NOT_A_HAIR_WORD.test(word));
  return colour ? `${colour.toLocaleLowerCase()} hair` : undefined;
}

/**
 * Name which head to replace, in terms that separate this person from the
 * others in the same frame.
 *
 * A character's swap prompt is a template meant to serve every scene they ever
 * appear in, so the person it names has to be identified generically — "the
 * white woman". That is accurate and ambiguous at once: in a shot where the
 * other man wore a white polo and faced the camera while she lay in profile,
 * the pass took his head and gave him her face.
 *
 * The discriminator therefore has to come from the scene, not the template.
 * Wardrobe settles it in almost every case and is already on the timeline;
 * where two people are undressed it falls through to hair colour.
 *
 * The second sentence matters as much as the first: passes chain, each editing
 * the last one's output, and until now nothing told a later pass to leave an
 * earlier correction alone.
 *
 * Empty when the frame holds nobody else — a single-figure shot has nothing to
 * confuse and keeps the template exactly as written.
 */
export function swapTargetClause(target: FramePerson, others: readonly FramePerson[]): string {
  if (others.length === 0) return "";

  const phrase = wardrobePhrase(target.wardrobe);
  const taken = new Set(
    others.map((person) => wardrobePhrase(person.wardrobe)).filter((p): p is string => Boolean(p)),
  );

  const parts: string[] = [];
  if (phrase) parts.push(phrase);
  if (!phrase || taken.has(phrase)) {
    const hair = hairToken(target.description);
    if (hair) parts.push(parts.length ? `with ${hair}` : hair);
  }
  if (parts.length === 0) return "";

  return (
    ` In Picture 1, replace only the head of the person ${parts.join(" ")}.` +
    " Leave every other person in Picture 1 exactly as they are."
  );
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
  frame: { wardrobe?: string; others?: readonly FramePerson[] } = {},
): Promise<string | null> {
  const references = referenceImagesOf(character);
  const reference = references[0];
  if (!reference) {
    logEvent("face_swap.skipped", {
      ...context,
      reason: "no_reference_image",
      character: character.name,
    });
    return null;
  }

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
      // Only the prompt is per-character; the LoRAs, steps and solver in
      // FACE_SWAP_SETTINGS are a matched set and stay as the preset defines.
      prompt: `${character.faceSwapPrompt?.trim() || FACE_SWAP_PROMPT}${swapTargetClause(
        { wardrobe: frame.wardrobe, description: character.description },
        frame.others ?? [],
      )}`,
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
