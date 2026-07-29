/**
 * Qwen Image Edit face-swap preset.
 *
 * Ported verbatim from the recipe proven in easynediacreator
 * (`lib/face-swap-preset.ts` + `lib/wan-gp/adapters/qwen-image-edit.ts`). The
 * prompt, LoRA pair, strengths and step count are a matched set — the head LoRA
 * expects the Lightning accelerator's 4-step schedule, and the prompt is written
 * around "Picture 1" and "Picture 2" meaning the guide image and the reference
 * respectively. Changing one without the others degrades the result, so they
 * live together and are applied as a unit.
 */

export const FACE_SWAP_PROMPT =
  "head_swap: start with Picture 1 as the base image, keeping its lighting, environment, " +
  "and background. remove the head of only the woman from Picture 1 completely and replace " +
  "it with the head of the woman from Picture 2, strictly preserving the hair, eye color, " +
  "nose structure of the woman in Picture 2. copy the direction of the eye, head rotation, " +
  "micro expressions of the woman from Picture 1, high quality, sharp details, 4k";

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
 * Settings a face-swap job needs beyond prompt and images.
 *
 * `video_prompt_type: "IV"` is what activates the reference alongside the guide
 * image on this model — the same counter-intuitive letter mechanism the
 * keyframe path uses.
 */
export const FACE_SWAP_SETTINGS: Record<string, unknown> = {
  image_mode: 1,
  image_prompt_type: "",
  video_prompt_type: "IV",
  image_refs_relative_size: 50,
  remove_background_images_ref: 1,
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
