import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { SEGMENT_SECONDS } from "@/lib/types";
import { familyOf } from "@/lib/wangp/family";
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
   * Rarely right. A model can publish an empty default simply because nothing
   * has been saved against it in the WanGP UI, and an empty value means the
   * reference images are ignored rather than that they are read plainly.
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
  /** The model can render past one window, so a published window size is not a clip ceiling. */
  slidingWindows?: boolean;
  /**
   * A hard ceiling on `video_length`, for variants with no sliding-window
    * support. H3 may publish its single-window size as a field bound, but that
    * is ignored when `slidingWindows` is enabled because Wan2GP can continue
    * beyond it.
   */
  maxFrames?: number;
  /**
   * WanGP's step-skipping cache, and the strength it runs at.
   *
   * Both halves or neither. `skip_steps_multiplier` arrives from WanGP's saved
   * state and is meaningless on its own, so a cache switched on beside an
   * inherited multiplier is a lottery: 1.75 gave a clean clip in 20 minutes and
   * the 0.08 sitting in the saved state skipped so much of the denoising that
   * the model abandoned the prompt and produced generic animation in 8.
   */
  stepSkipping?: { cacheType: string; multiplier: number; startStepPerc?: number };
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
  // Ref2VA accepts the standard WanGP LoRA settings even though its model
  // schema does not advertise them.
  const supported = declared || familyOf(schema.modelType) === "minimax_ref2va";

  if (!supported) {
    // Silently dropping a selection would render something plausible with no
    // LoRA applied and nothing to debug, so refuse instead.
    if (loras.length) {
      throw new Error(
        `Model ${schema.modelType} accepts no LoRAs, but ${loras.length} ` +
          `${loras.length === 1 ? "is" : "are"} selected: ${loras.map((l) => l.name).join(", ")}. ` +
          "Clear the LoRAs on the project settings screen, or on this scene if it overrides them, " +
          "and render again.",
      );
    }
    return;
  }

  settings.activated_loras = loras.map((lora) => lora.name);

  if (
    !declared ||
    fieldNames.has("loras_multipliers") ||
    "loras_multipliers" in schema.defaultSettings
  ) {
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
    if (!overrides.slidingWindows && lengthField?.max !== undefined) {
      frames = Math.min(lengthField.max, frames);
    }
    if (overrides.maxFrames !== undefined) frames = Math.min(overrides.maxFrames, frames);
    settings.video_length = frames;
  }

  // One prompt, however many lines it has.
  //
  // `multi_prompts_gen_type` decides what a carriage return in the prompt
  // means. WanGP's saved state for MiniMax H3 arrives as "PG", and a labelled
  // multi-section prompt sent under it came back as a clip bearing no relation
  // to any of its sections. A hand-made run of the same model that worked has
  // "FG", so that is what a multi-line prompt is sent with. Written directly
  // because it is saved UI state rather than a declared field, exactly like
  // `batch_size`.
  if (
    String(overrides.prompt).includes("\n") &&
    "multi_prompts_gen_type" in schema.defaultSettings
  ) {
    settings.multi_prompts_gen_type = "FG";
  }

  // The step-skipping cache is deliberately not set here.
  //
  // It belongs to WanGP: the cache type is chosen per model in its own UI and
  // arrives in `defaultSettings`, so a model configured for Spectrum gets it
  // without this having to know. Setting it from here once meant switching on a
  // cache for a model whose UI had never been configured for one, which is how
  // a clip came back with no relation to its prompt.
  //
  // (`skip_steps_multiplier` travels in those defaults too and looks like the
  // strength control. It is not one for Spectrum — that offers only a start
  // percentage — so the value is leftover state from a different cache type.)

  // Refuse rather than quietly render a text-to-video clip.
  //
  // `setIf` drops any field the model does not declare, so a video model with
  // no conditioning inputs turns a clip built from keyframes into one built
  // from the prompt alone — which looks disappointing rather than broken, and
  // so gets blamed on the prompt. MiniMax H3 is the live example: its FL2VA
  // variants declare image_start/image_end, its Ref2VA variants declare
  // neither, and both report the same family.
  const missingConditioning = [
    ["image_start", overrides.imageStart],
    ["image_end", overrides.imageEnd],
    ["video_source", overrides.videoSource],
  ].filter(([name, value]) => value !== undefined && !fieldNames.has(name as string));
  if (missingConditioning.length) {
    throw new Error(
      `Model ${schema.modelType} does not accept ${missingConditioning
        .map(([name]) => String(name))
        .join(", ")}, so those inputs would be silently ignored. Pin a video model that declares ` +
        "every selected conditioning input.",
    );
  }

  setIf("image_start", overrides.imageStart);
  setIf("image_end", overrides.imageEnd);

  // `image_prompt_type` is a combinable letter set: "S" start image, "E" end image,
  // "V" continue from source video, "L" continue from the last generated video
  // (LTX-2 publishes `allowed: "TSEVL"`). Build the exact active set in that
  // canonical order rather than inheriting saved UI state. In particular, a
  // continuation with an end image is "EV": no start image, one destination
  // image, and a supplied source video.
  if (overrides.videoSource) {
    setIf("video_source", overrides.videoSource);
  }
  const imagePromptType = [
    overrides.imageStart && fieldNames.has("image_start") ? "S" : "",
    overrides.imageEnd && fieldNames.has("image_end") ? "E" : "",
    overrides.videoSource && fieldNames.has("video_source") ? "V" : "",
  ].join("");
  if (imagePromptType) setIf("image_prompt_type", imagePromptType);

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
