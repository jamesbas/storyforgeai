import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { LoraSelection } from "@/lib/schemas/lora";
import type { WangpModelSchema, WangpGenerationSettings, WangpPurpose } from "@/lib/schemas/wangp";

/**
 * Frame count for a clip of `seconds` at `fps`, aligned to WanGP's 8-frame
 * boundary plus one (spec Section 11.1). Matches the alignment WanGP requires
 * for `video_length`; at the default 20s and 16/24/30 fps this equals fps*20+1.
 */
export function frameCountForFps(fps: number, seconds = SEGMENT_SECONDS): number {
  return Math.ceil((fps * seconds) / 8) * 8 + 1;
}

export type ManifestOverrides = {
  sceneId: string;
  purpose: WangpPurpose;
  prompt: string;
  negativePrompt?: string;
  imageStart?: string;
  imageEnd?: string;
  /**
   * Reference images for identity conditioning (WanGP `image_refs`).
   *
   * Absolute paths readable by the WanGP process. Verified against a live
   * server: WanGP opens each path and fails the job with `[Errno 2]` if it is
   * missing, so a bad path surfaces immediately rather than silently rendering
   * the wrong subject.
   */
  imageRefs?: string[];
  /**
   * Whether the first entry of `imageRefs` is a scene frame rather than a
   * person. WanGP's reference group distinguishes the two: "I" means the
   * references are people/objects, "KI" means the first is the main subject or
   * landscape and may be followed by people/objects.
   */
  imageRefsLeadWithScene?: boolean;
  /**
   * Leave `video_prompt_type` at whatever the model ships with.
   *
   * The letters are a WanGP convention, not a universal one, and a model can
   * publish an empty default because it consumes `image_refs` directly. MiniMax
   * H3's reference variant is that case: forcing "KI" onto it changed which
   * picture the model treated as the opening frame.
   */
  keepModelReferenceGroup?: boolean;
  /**
   * Clip this generation continues from (WanGP `video_source`). Absolute path
   * readable by the WanGP process; it is ffprobed on submission, so a missing
   * file fails the job immediately rather than silently rendering a fresh shot.
   */
  videoSource?: string;
  /**
   * LoRAs to activate for this generation, already reconciled against the
   * resolved model's catalog. Order is significant: `loras_multipliers` is
   * matched to `activated_loras` by index.
   */
  loras?: LoraSelection[];
  fps?: number;
  resolution?: string;
  /** Pinned image seed. Left unset, WanGP picks a fresh one per job. */
  seed?: number;
  /** Denoising steps. Left unset, the model's own default stands. */
  steps?: number;
  /** Audio models: clip length in seconds. Video: segment length for frame maths. */
  durationSeconds?: number;
  /**
   * A hard ceiling on `video_length`, for variants with no sliding-window
   * support. No H3 variant publishes field bounds, so nothing in the schema
   * will stop an over-long request — it is accepted and then fails or truncates
   * at render time.
   */
  maxFrames?: number;
  /**
   * WanGP's step-skipping cache (`skip_steps_cache_type`), e.g. `"spectrum"`.
   *
   * Applied only where the model publishes the control, and only ever alongside
   * the model's full step count. A reduced step count with no accelerator
   * active is the failure `resolveSteps` exists to prevent, and it looks
   * identical to a cache set too aggressively.
   */
  skipStepsCacheType?: string;
  /**
   * Post-generation upscaler (WanGP `spatial_upsampling`). Not a declared
   * field on any model, so it is written straight onto the settings when the
   * model carries one — the same treatment `batch_size` needs.
   */
  spatialUpsampling?: string;
};

/**
 * Pick a frame rate: honour a discrete choice list, else clamp to any published
 * range, else use the requested value. Falls back to 24 (LTX-2's native rate)
 * when the model publishes nothing.
 */
function resolveFps(
  field: { allowed?: unknown[]; min?: number; max?: number } | undefined,
  requested: number | undefined,
): number {
  let fps = requested ?? 24;
  const allowed = field?.allowed as number[] | undefined;
  if (allowed?.length) {
    if (!allowed.includes(fps)) fps = allowed[0]!;
    return fps;
  }
  if (field?.min !== undefined) fps = Math.max(field.min, fps);
  if (field?.max !== undefined) fps = Math.min(field.max, fps);
  return fps;
}

/**
 * Write the LoRA stack, unconditionally.
 *
 * `defaultSettings` is a copy of WanGP's saved per-model settings, and those
 * carry whatever LoRAs were last selected in the WanGP UI. Leaving the field
 * untouched lets a project silently inherit them, so the same storyboard can
 * render differently depending on what someone last clicked in another
 * application. Writing it every time — including as an empty list — makes a
 * project fully determine its own render.
 *
 * The two fields always move together: a multiplier string left over from the
 * defaults would mis-weight a freshly chosen stack.
 */
function applyLoras(
  settings: Record<string, unknown>,
  schema: WangpModelSchema,
  fieldNames: Set<string>,
  loras: LoraSelection[],
): void {
  const declared =
    fieldNames.has("activated_loras") || "activated_loras" in schema.defaultSettings;

  if (!declared) {
    // Silently dropping a selection would render something plausible with no
    // LoRA applied and nothing to debug, so refuse instead.
    if (loras.length) {
      throw new Error(
        `Model ${schema.modelType} accepts no LoRAs, but ${loras.length} ` +
          `${loras.length === 1 ? "is" : "are"} selected: ${loras.map((l) => l.name).join(", ")}. ` +
          "Clear the video LoRAs on the project settings screen, or on this scene if it overrides " +
          "them, and render again. MiniMax H3's reference variant is the common case — it takes " +
          "no LoRAs at all, and accelerators destroy the identity binding it exists to provide.",
      );
    }
    return;
  }

  settings.activated_loras = loras.map((lora) => lora.name);

  if (fieldNames.has("loras_multipliers") || "loras_multipliers" in schema.defaultSettings) {
    // A plain number per LoRA. WanGP also accepts phase (`;`) and step (`|`)
    // syntax, which the UI does not model — see docs/LORA Use.md section 4.6.
    settings.loras_multipliers = loras.map((lora) => String(lora.strength)).join(" ");
  }
}

/**
 * Build a settings manifest from a model's default settings, changing only
 * schema-supported fields (spec Sections 11.2 / 11.3). FPS and video length are
 * validated against the model's allowed values when present.
 */
export function buildSettingsManifest(
  schema: WangpModelSchema,
  overrides: ManifestOverrides,
): WangpGenerationSettings {
  const settings: Record<string, unknown> = { ...schema.defaultSettings };
  const fieldNames = new Set(schema.fields.map((f) => f.name));

  const setIf = (name: string, value: unknown) => {
    if (fieldNames.has(name) && value !== undefined) settings[name] = value;
  };

  setIf("prompt", overrides.prompt);
  setIf("negative_prompt", overrides.negativePrompt ?? "");
  setIf("resolution", overrides.resolution);
  setIf("seed", overrides.seed);
  setIf("num_inference_steps", overrides.steps);

  // WanGP can rewrite the prompt with its own local LLM before generating.
  // Several models ship with it enabled (LTX-2 22B defaults to "T"), which
  // would silently discard the prompts our agents crafted. Always disable it.
  if (fieldNames.has("prompt_enhancer")) settings.prompt_enhancer = "";

  // One render per job.
  //
  // `batch_size` is saved WanGP UI state rather than a declared field, so it
  // arrives in the defaults and travels into every job unexamined. A stack left
  // at 2 rendered two images per keyframe and roughly doubled the time, while
  // the pipeline only ever consumes the first. `repeat_generation` is the same
  // control by another name on some models.
  for (const field of ["batch_size", "repeat_generation"]) {
    if (field in schema.defaultSettings) settings[field] = 1;
  }

  // Same class of inherited UI state, and the one the low-resolution strategy
  // depends on: generating at 480p without the upscale is half the recipe.
  if (overrides.spatialUpsampling !== undefined && "spatial_upsampling" in schema.defaultSettings) {
    settings.spatial_upsampling = overrides.spatialUpsampling;
  }

  // Frame count and frame rate are independent controls. Some models expose
  // `force_fps` (often as an empty string meaning "model native"), some expose
  // none at all — LTX-2 19B has `video_length` but no fps field whatsoever.
  // Setting video_length only when an fps field existed silently left every
  // clip at the model's default length, ignoring the segment duration.
  const fpsField = schema.fields.find((f) => f.name === "force_fps");
  const fps = resolveFps(fpsField, overrides.fps);

  if (fpsField && overrides.fps !== undefined && typeof schema.defaultSettings.force_fps === "number") {
    // Only pin fps when the model genuinely drives it numerically.
    settings.force_fps = fps;
  }

  if (fieldNames.has("video_length") && overrides.fps !== undefined) {
    const lengthField = schema.fields.find((f) => f.name === "video_length");
    let frames = frameCountForFps(fps, overrides.durationSeconds ?? SEGMENT_SECONDS);
    if (lengthField?.min !== undefined) frames = Math.max(lengthField.min, frames);
    if (lengthField?.max !== undefined) frames = Math.min(lengthField.max, frames);
    if (overrides.maxFrames !== undefined) frames = Math.min(overrides.maxFrames, frames);
    settings.video_length = frames;
  }

  // Only where the model has this control at all.
  //
  // This was written unconditionally on the reasoning that `wgp.py` validates
  // the value and would fail loudly for a model that does not support it. That
  // was wrong: a Ref2VA job accepted `"spectrum"` — a key absent from both its
  // declared fields and its saved settings — and returned a clip bearing no
  // relation to its prompt. An optimisation is never worth a silent risk of
  // that, so it now follows the same rule as every other undeclared field.
  if (
    overrides.skipStepsCacheType !== undefined &&
    (fieldNames.has("skip_steps_cache_type") || "skip_steps_cache_type" in schema.defaultSettings)
  ) {
    settings.skip_steps_cache_type = overrides.skipStepsCacheType;
  }

  // Refuse rather than quietly render a text-to-video clip.
  //
  // `setIf` drops any field the model does not declare, so a video model with
  // no conditioning inputs turns a clip built from keyframes into one built
  // from the prompt alone — which looks disappointing rather than broken, and
  // so gets blamed on the prompt. MiniMax H3 is the live example: its FL2VA
  // variants declare image_start/image_end, its Ref2VA variants declare
  // neither, and both report the same family.
  const conditioning = [overrides.imageStart, overrides.imageEnd, overrides.videoSource];
  if (
    conditioning.some((value) => value !== undefined) &&
    !["image_start", "image_end", "video_source"].some((name) => fieldNames.has(name))
  ) {
    throw new Error(
      `Model ${schema.modelType} accepts no start frame, end frame or source video, so this ` +
        "clip would be rendered from the prompt alone. Pin a video model that takes keyframes — " +
        "for MiniMax H3 that is an FL2VA variant, not Ref2VA.",
    );
  }

  setIf("image_start", overrides.imageStart);
  setIf("image_end", overrides.imageEnd);

  // Continuation replaces the keyframe pathway rather than joining it.
  //
  // `image_prompt_type` is a letter set: "S" start image, "E" end image,
  // "V" continue from source video, "L" continue from the last generated video
  // (LTX-2 publishes `allowed: "TSEVL"`). Models ship it pre-set — LTX-2
  // defaults to "SE" — which is why start/end keyframes work today without
  // anything setting it. Continuing means overriding that default to "V", since
  // leaving "SE" in place would make WanGP demand keyframes this mode does not
  // render.
  if (overrides.videoSource) {
    setIf("video_source", overrides.videoSource);
    setIf("image_prompt_type", "V");
  }

  // Reference images are passed as a list even for a single character: the
  // models that accept them advertise `multiple_references`, and a list is what
  // a multi-character cast needs. An empty list is omitted so the reference
  // pathway stays entirely inactive when no characters are pinned.
  if (overrides.imageRefs?.length) {
    setIf("image_refs", overrides.imageRefs);

    // Strip the background behind the person in a reference image. WanGP labels
    // this "Remove Background behind People / Objects", and with it off the
    // whole photo — setting, colours, composition — acts as the reference,
    // diluting the identity signal it was supplied for.
    if (config.media.removeReferenceBackground) setIf("remove_background_images_ref", 1);

    // Activating references is counter-intuitively `video_prompt_type`, not
    // `image_prompt_type`, even on pure image models. Verified against a live
    // WanGP: image models publish `image_prompt_type.allowed = ""` (text only),
    // while `video_prompt_type` carries the reference group with
    // `letters_filter: "KI"` —
    //   ""   none
    //   "KI" first reference is the main subject / landscape
    //   "I"  references are people / objects   <- character identity
    //
    // The letter is enforced in both directions: `image_refs` without it is
    // ignored, and the letter without `image_refs` fails the job with
    // "You must provide at least one Reference Image".
    //
    // It is set explicitly rather than merged into the model's default,
    // because the other letter groups in this field select guide and mask
    // inputs this pathway never sends. Flux 2 Klein ships "MV" (mask + video
    // guide); keeping that would make WanGP demand images we do not provide.
    //
    // Except where the model publishes an empty default and takes `image_refs`
    // directly — then the letters are not its language and writing them changes
    // how it reads the pictures.
    if (!overrides.keepModelReferenceGroup) {
      setIf("video_prompt_type", overrides.imageRefsLeadWithScene ? "KI" : "I");
    }
  } else if (!overrides.keepModelReferenceGroup) {
    // Same reason in reverse: left alone, Flux 2 Klein's "MV" default demands a
    // control image this pathway never sends.
    setIf("video_prompt_type", "");
  }

  // Audio models express length in seconds, clamped to any published bounds.
  //
  // Gated on purpose because video models declare this field too and mean
  // something else by it: writing a clip's length here sent `duration_seconds`
  // on every video job against a WanGP default of 0.
  const durationField = schema.fields.find((f) => f.name === "duration_seconds");
  if (overrides.purpose === "audio" && durationField && overrides.durationSeconds !== undefined) {
    let seconds = overrides.durationSeconds;
    if (durationField.min !== undefined) seconds = Math.max(durationField.min, seconds);
    if (durationField.max !== undefined) seconds = Math.min(durationField.max, seconds);
    settings.duration_seconds = seconds;
  }

  applyLoras(settings, schema, fieldNames, overrides.loras ?? []);

  return {
    id: randomUUID(),
    sceneId: overrides.sceneId,
    purpose: overrides.purpose,
    modelType: schema.modelType,
    settings,
    status: "draft",
    generatedFiles: [],
    errors: [],
  };
}
