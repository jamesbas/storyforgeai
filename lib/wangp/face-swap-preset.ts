/**
 * Face-swap presets, one per swap engine.
 *
 * Two engines can do this job and they want opposite treatment. The Qwen recipe
 * is a matched set — the head LoRA expects the Lightning accelerator's 4-step
 * schedule, so the LoRA pair, strengths, solver and step count stand or fall
 * together. Krea 2 Turbo Identity Edit is a single distilled checkpoint built
 * for exactly this task and wants none of it.
 *
 * The wording differs too. Qwen responds to a long transplant instruction
 * addressed to "Picture 1" and "Picture 2"; Krea wants a short edit addressed
 * to "the first image" and "the 2nd reference image", and does worse with the
 * Qwen phrasing. Both receive the frame first and the reference face second.
 */

import type { WangpModelSchema } from "@/lib/schemas/wangp";

/** The swap engines a character can be pointed at. */
export const FACE_SWAP_METHODS = ["krea", "qwen"] as const;

export type FaceSwapMethod = (typeof FACE_SWAP_METHODS)[number];

/**
 * Krea, which testing put ahead of the Qwen recipe on likeness.
 *
 * This is the answer for a character that has never been given one, so it also
 * decides what every character saved before the setting existed now does.
 * Chosen over grandfathering them onto Qwen because the two paths take the same
 * prompt and the same reference photo, so the switch costs no configuration —
 * and leaving the old engine in place would have meant most characters silently
 * keeping the worse one forever.
 */
export const DEFAULT_FACE_SWAP_METHOD: FaceSwapMethod = "krea";

/**
 * Who the prompt is about.
 *
 * Both engines need the person named, and neither can be told "the character".
 * The wording used to be fixed at "the woman", which meant every male character
 * started from a prompt that was wrong and had to be hand-corrected in four
 * places.
 */
export const FACE_SWAP_SUBJECTS = ["woman", "man"] as const;

export type FaceSwapSubject = (typeof FACE_SWAP_SUBJECTS)[number];

export const DEFAULT_FACE_SWAP_SUBJECT: FaceSwapSubject = "woman";

/** The wording each engine responds to, per subject. */
const FACE_SWAP_PROMPT_TEMPLATES: Record<FaceSwapMethod, (subject: FaceSwapSubject) => string> = {
  qwen: (s) =>
    "head_swap: start with Picture 1 as the base image, keeping its lighting, environment, " +
    `and background. remove the head of only the ${s} from Picture 1 completely and replace ` +
    `it with the head of the ${s} from Picture 2, strictly preserving the hair, eye color, ` +
    `nose structure of the ${s} in Picture 2. copy the direction of the eye, head rotation, ` +
    `micro expressions of the ${s} from Picture 1, high quality, sharp details, 4k`,
  krea: (s) =>
    `change the ${s}'s face in the first image using the ${s} depicted in the 2nd reference ` +
    "image. keep proportions of the head and face aligned with the original reference image.",
};

/** The starting wording for a character, before any edit of their own. */
export function faceSwapPromptFor(method: FaceSwapMethod, subject: FaceSwapSubject): string {
  return FACE_SWAP_PROMPT_TEMPLATES[method](subject);
}

/**
 * Whether this text is still one of the generated defaults.
 *
 * Switching engine or subject has to re-seed the box, or a character would keep
 * Qwen's transplant wording on Krea and quietly get worse results. It must not
 * re-seed over wording someone wrote themselves, which is the only thing
 * separating a helpful default from losing their work.
 */
export function isDefaultFaceSwapPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return FACE_SWAP_METHODS.some((method) =>
    FACE_SWAP_SUBJECTS.some((subject) => faceSwapPromptFor(method, subject) === trimmed),
  );
}

/**
 * How each engine's prompt refers to the frame, for the clause the app appends
 * when more than one person is in shot.
 */
const FACE_SWAP_TARGET_CLAUSES: Record<FaceSwapMethod, (who: string) => string> = {
  qwen: (who) =>
    ` In Picture 1, replace only the head of the person ${who}.` +
    " Leave every other person in Picture 1 exactly as they are.",
  krea: (who) =>
    ` In the first image, change only the face of the person ${who}.` +
    " Leave every other person in the first image exactly as they are.",
};

/** The disambiguating sentence, in the terms the chosen engine understands. */
export function faceSwapTargetClauseFor(method: FaceSwapMethod, who: string): string {
  return FACE_SWAP_TARGET_CLAUSES[method](who);
}

/**
 * The accelerator and the head LoRA, in the order their multipliers assume.
 *
 * The accelerator is named by its full URL and the head LoRA by bare filename,
 * because that is verbatim how a working job from WanGP's own UI names them.
 * Shortening the URL to a filename looks equivalent and is not: accelerators
 * live in a separate `loras_accelerators` folder, so the bare name does not
 * resolve and the Lightning LoRA silently drops — leaving a 4-step, CFG-1 job
 * running without the schedule those numbers assume.
 */
export const FACE_SWAP_LORAS = [
  {
    name: "https://huggingface.co/DeepBeepMeep/Qwen_image/resolve/main/loras_accelerators/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    strength: 0.8,
  },
  { name: "bfs_head_v5_2511_merged_version_rank_16_fp16.safetensors", strength: 0.5 },
] as const;

export const FACE_SWAP_STEPS = 4;

/**
 * What each engine runs at when a character has not said otherwise.
 *
 * Qwen's 4 is set by its preset and is not a free number: the head LoRA expects
 * the Lightning accelerator's four-step schedule. Krea's is the checkpoint's
 * own published default, which the app does not send at all — repeated here
 * only so the form can show what will happen, not to be sent.
 */
export const FACE_SWAP_STEP_HINT: Record<FaceSwapMethod, number> = {
  qwen: FACE_SWAP_STEPS,
  krea: 8,
};

/**
 * Settings a Qwen Image Edit swap needs beyond prompt and images.
 *
 * `video_prompt_type` is set per job by `faceSwapImageSettings`, since the
 * letter depends on which reference contract the model publishes.
 */
export const QWEN_FACE_SWAP_SETTINGS: Record<string, unknown> = {
  image_prompt_type: "",
  num_inference_steps: FACE_SWAP_STEPS,
  sample_solver: "lightning",
  guidance_scale: 1,
  guidance_phases: 1,
  model_mode: 1,
  masking_strength: 1,
  mask_expand: 0,
  activated_loras: FACE_SWAP_LORAS.map((lora) => lora.name),
  loras_multipliers: FACE_SWAP_LORAS.map((lora) => lora.strength).join(" "),
};

/**
 * Recipe values WanGP honours but publishes in no schema.
 *
 * These have to bypass the field filter. The rule that a field counts as known
 * when it is declared or defaulted holds for model settings and not for these,
 * and applying it anyway silently stripped three values out of a recipe that
 * had been proven working.
 *
 * `image_mode: 1` is the load-bearing one: it says the job is a still. The Qwen
 * edit definition also declares `video_length` and `force_fps`, so without it
 * the server reads the job as video and rejects it outright — every Qwen swap
 * failed with "You must provide a Control Video", the frame in `image_guide`
 * having been taken for a control video nobody supplied. The other two govern
 * how the reference face is composited. All three are verified accepted live on
 * server 1.10.1; `mask_expand` is deliberately not among them, since the pass
 * supplies a reference face rather than a mask.
 *
 * Krea gets none of it. Its definition has no video mode to disambiguate, and
 * it composites references differently — there is nothing to fix and no reason
 * to vary a path that is known good.
 */
const FACE_SWAP_UNPUBLISHED: Record<FaceSwapMethod, Record<string, unknown>> = {
  qwen: { image_mode: 1, image_refs_relative_size: 50, remove_background_images_ref: 1 },
  krea: {},
};

/** Recipe values for an engine that no schema publishes, sent unfiltered. */
export function faceSwapTaskFlagsFor(method: FaceSwapMethod): Record<string, unknown> {
  return FACE_SWAP_UNPUBLISHED[method];
}

/**
 * Settings a Krea 2 Turbo Identity Edit swap needs — which is almost none.
 *
 * The checkpoint is purpose-built for identity transfer and already distilled,
 * and it publishes no `guidance_scale`, `sample_solver`, `guidance_phases` or
 * mask controls at all. Its own step count is tuned for it, so the Qwen
 * preset's 4 would be a number borrowed from a schedule that is not running.
 * Everything absent here is therefore deliberate: the model's defaults are
 * better informed than we are.
 *
 * The LoRA slots are the exception, and they are cleared rather than left
 * alone. Krea does declare `activated_loras`, so filtering by "does this model
 * publish the field" would happily hand it the Qwen Lightning accelerator and
 * the `bfs_head` LoRA — Qwen-architecture files, on a Krea checkpoint. Omitting
 * them is not enough either: WanGP serves saved UI state as defaults, so an
 * empty stack has to be asserted or whatever was last clicked in another
 * application rides along.
 */
export const KREA_FACE_SWAP_SETTINGS: Record<string, unknown> = {
  activated_loras: [],
  loras_multipliers: "",
};

/** The settings block for a swap engine, before it is filtered to a schema. */
export function faceSwapPresetFor(method: FaceSwapMethod): Record<string, unknown> {
  return method === "qwen" ? QWEN_FACE_SWAP_SETTINGS : KREA_FACE_SWAP_SETTINGS;
}

/**
 * The preset reduced to the fields this checkpoint actually publishes.
 *
 * Face swap is the one generation path that does not build its request through
 * `buildSettingsManifest`, so it was the one path that could hand a model a
 * control it has never heard of. Live on server 1.10.1,
 * `qwen_image_edit_plus2_20B` publishes neither a declaration nor a default for
 * `image_mode`, and `krea2_turbo_edit` publishes no `guidance_scale` at all —
 * there CFG is disabled rather than zero, and a fallback value is a schema
 * error rather than a harmless no-op.
 *
 * Knowing a field means declaring it *or* publishing a default for it, not
 * declaring it alone: `model_mode` and `masking_strength` are real controls on
 * the swap model that appear only among its defaults.
 */
export function faceSwapSettingsFor(
  schema: WangpModelSchema,
  preset: Record<string, unknown>,
): Record<string, unknown> {
  const known = new Set([
    ...schema.fields.map((field) => field.name),
    ...Object.keys(schema.defaultSettings ?? {}),
  ]);
  return Object.fromEntries(Object.entries(preset).filter(([name]) => known.has(name)));
}

/**
 * How this model wants to be handed the frame being corrected.
 *
 * Two live contracts. The older Qwen edit definition takes the frame in
 * `image_guide` and pairs it with the face through `video_prompt_type: "IV"`.
 * The current one has dropped `image_guide` for an ordered `image_refs`, where
 * `"KI"` marks the first entry as the shot and the rest as people to place in
 * it.
 *
 * Decided by what the model declares rather than by version, because getting it
 * wrong is silent: WanGP sets only the fields a schema declares, so a guide
 * sent to a definition that no longer has one is discarded without complaint
 * and the job runs on the face alone — which still returns a picture, of the
 * wrong shot.
 *
 * Krea 2 Turbo Identity Edit publishes no `image_guide` either, so it takes the
 * same ordered pair as the current Qwen definition: frame first, face second.
 */
export function faceSwapImageSettings(
  framePath: string,
  referencePath: string,
  declaresImageGuide: boolean,
): Record<string, unknown> {
  return declaresImageGuide
    ? { image_guide: framePath, image_refs: [referencePath], video_prompt_type: "IV" }
    : { image_refs: [framePath, referencePath], video_prompt_type: "KI" };
}
