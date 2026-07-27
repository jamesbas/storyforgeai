/**
 * Canonical setting vocabulary for StoryForgeAI, plus the WanGP field-name
 * aliases each canonical name may appear under.
 *
 * Ported from the field-candidate lists in easynediacreator
 * (`lib/wan-gp/adapters/*` + `lib/wan-gp/settings-builder.ts`), which were
 * verified against a live WanGP installation.
 *
 * The rest of the app only ever speaks the canonical vocabulary. The live MCP
 * client renames canonical keys to the installed model's real keys immediately
 * before `wangp_generate`, and renames discovered defaults the other way when a
 * model schema is normalized. This keeps model/version drift confined to this
 * single table.
 */

export const CANONICAL_ALIASES = {
  prompt: ["prompt", "text_prompt"],
  negative_prompt: ["negative_prompt"],
  resolution: ["resolution", "size"],
  num_inference_steps: ["num_inference_steps", "steps"],
  guidance_scale: ["guidance_scale", "cfg_scale"],
  force_fps: ["force_fps", "fps", "frames_per_second", "frame_rate"],
  video_length: ["video_length", "num_frames", "frame_num"],
  /**
   * Audio length. Audio-only models (ACE-Step, Stable Audio 3) use this as the
   * real duration control; video models expose it for unrelated purposes, so
   * only audio manifests should set it.
   */
  duration_seconds: ["duration_seconds", "audio_duration", "duration"],
  image_start: ["image_start", "start_image", "start_frame", "input_image", "image"],
  image_end: ["image_end", "end_image", "end_frame"],
  image_refs: ["image_refs"],
  image_guide: ["image_guide"],
  image_mask: ["image_mask"],
  image_prompt_type: ["image_prompt_type"],
  video_prompt_type: ["video_prompt_type"],
  prompt_enhancer: ["prompt_enhancer"],
  image_mode: ["image_mode"],
  input_video_strength: ["input_video_strength"],
  seed: ["seed"],
  sample_solver: ["sample_solver"],
  scheduler: ["scheduler", "scheduler_type", "scheduler_name"],
  activated_loras: ["activated_loras"],
  loras_multipliers: ["loras_multipliers"],
} as const;

export type CanonicalField = keyof typeof CANONICAL_ALIASES;

const CANONICAL_FIELDS = Object.keys(CANONICAL_ALIASES) as CanonicalField[];

/** Canonical names whose values are numeric, used to coerce discovered choices. */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set<CanonicalField>([
  "num_inference_steps",
  "guidance_scale",
  "force_fps",
  "video_length",
  "duration_seconds",
  "input_video_strength",
  "seed",
  "image_mode",
]);

/** canonical name -> the real WanGP key on the installed model. */
export type FieldMap = Record<string, string>;

/**
 * Resolve the canonical vocabulary against the keys a model actually exposes.
 * A canonical name is omitted when the model exposes none of its aliases, which
 * is how callers detect unsupported capabilities (e.g. no `image_end`).
 */
export function resolveFieldMap(keys: ReadonlySet<string>): FieldMap {
  const map: FieldMap = {};
  for (const canonical of CANONICAL_FIELDS) {
    const actual = CANONICAL_ALIASES[canonical].find((alias) => keys.has(alias));
    if (actual) map[canonical] = actual;
  }
  return map;
}

/** Invert a field map for renaming discovered defaults into canonical form. */
export function invertFieldMap(map: FieldMap): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [canonical, actual] of Object.entries(map)) inverted[actual] = canonical;
  return inverted;
}

/**
 * Rename canonical keys to the installed model's real keys. Keys that are not
 * part of the canonical vocabulary pass through untouched so model-specific
 * defaults survive the round trip.
 */
export function toWangpSettings(
  settings: Record<string, unknown>,
  map: FieldMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    out[map[key] ?? key] = value;
  }
  return out;
}
