/**
 * Centralized configuration and feature flags.
 * Reads process.env once and exposes a typed, immutable object.
 * Every external integration defaults to off/local so the app boots in demo mode
 * with an empty environment (generic-build-spec Section 5.2).
 */

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type PersistenceMode = "memory" | "file" | "prisma";

/**
 * Defaults to `file`: a storyboard costs minutes of GPU time, and losing every
 * project on restart is a poor trade for the simplicity of an in-memory store.
 * `memory` stays available for tests and throwaway runs.
 */
const persistenceRaw = str(process.env.STORYFORGE_PERSISTENCE, "file");
const persistence: PersistenceMode =
  persistenceRaw === "prisma" ? "prisma" : persistenceRaw === "memory" ? "memory" : "file";

export const config = {
  env: str(process.env.NODE_ENV, "development"),
  dataDir: str(process.env.STORYFORGE_DATA_DIR, "./projects"),
  persistence,
  defaults: {
    segmentSeconds: int(process.env.DEFAULT_SEGMENT_SECONDS, 20),
    aspectRatio: str(process.env.DEFAULT_ASPECT_RATIO, "16:9"),
    fps: int(process.env.DEFAULT_FPS, 24),
    resolution: str(process.env.DEFAULT_RESOLUTION, "1280x720"),
  },
  flags: {
    aiPlanning: bool(process.env.AI_PLANNING_ENABLED, false),
    wangpMcp: bool(process.env.WANGP_MCP_ENABLED, false),
    ffmpeg: bool(process.env.FFMPEG_ENABLED, false),
    deepyAssist: bool(process.env.DEEPY_ASSIST_ENABLED, false),
    animaticAssembly: bool(process.env.ANIMATIC_ASSEMBLY_ENABLED, false),
    platformDerivatives: bool(process.env.PLATFORM_DERIVATIVES_ENABLED, false),
  },
  ffmpeg: {
    path: str(process.env.FFMPEG_PATH, "ffmpeg"),
    probePath: str(process.env.FFPROBE_PATH, "ffprobe"),
    preset: str(process.env.FFMPEG_PRESET, "medium"),
    crf: int(process.env.FFMPEG_CRF, 20),
    timeoutMs: int(process.env.FFMPEG_TIMEOUT_MS, 900_000),
    // Defaults match WanGP LTX-2 output (aac, 48 kHz, stereo) so the assembly
    // re-encode is a passthrough-equivalent rather than a resample.
    audioCodec: str(process.env.FFMPEG_AUDIO_CODEC, "aac"),
    audioBitrate: str(process.env.FFMPEG_AUDIO_BITRATE, "192k"),
    audioSampleRate: int(process.env.FFMPEG_AUDIO_SAMPLE_RATE, 48_000),
    audioChannelLayout: str(process.env.FFMPEG_AUDIO_CHANNEL_LAYOUT, "stereo"),
  },
  wangp: {
    url: str(process.env.WANGP_MCP_URL, "http://127.0.0.1:7866/mcp"),
    outputDir: str(process.env.WANGP_OUTPUT_DIR, ""),
    loraRoot: str(process.env.WANGP_LORA_ROOT, ""),
    /**
     * LoRA Manager sidecar records (`<name>.json` with display name and trigger
     * words). Defaults to the `loras_metadata` folder WanGP keeps beside
     * `loras`, so configuring `WANGP_LORA_ROOT` alone is enough.
     */
    loraMetadataRoot: str(process.env.WANGP_LORA_METADATA_ROOT, ""),
    // Live generation is minutes-long; the mock completes in two polls.
    pollIntervalMs: int(process.env.WANGP_POLL_INTERVAL_MS, 3000),
    maxPollAttempts: int(process.env.WANGP_MAX_POLL_ATTEMPTS, 600),
    /**
     * Explicit model pins. WanGP publishes ~200 models with no quality ranking,
     * so automatic selection cannot tell a general text-to-image model from an
     * inpainting or avatar variant. Pin the models you actually want.
     */
    videoModel: str(process.env.WANGP_VIDEO_MODEL, ""),
    imageModel: str(process.env.WANGP_IMAGE_MODEL, ""),
    audioModel: str(process.env.WANGP_AUDIO_MODEL, ""),
  },
  openai: {
    apiKey: str(process.env.OPENAI_API_KEY, ""),
    model: str(process.env.OPENAI_MODEL, "gpt-4o-mini"),
    /** Point at any OpenAI-compatible server, e.g. LM Studio on :1234/v1. */
    baseUrl: str(process.env.OPENAI_BASE_URL, ""),
    temperature: Number(process.env.OPENAI_TEMPERATURE ?? "0.7"),
    /**
     * Hard caps. Reasoning models spend this budget on thinking before they
     * emit any content, so a low cap truncates the answer rather than
     * shortening it. A generous ceiling costs nothing when unused.
     */
    maxTokens: int(process.env.OPENAI_MAX_TOKENS, 12_000),
    timeoutMs: int(process.env.OPENAI_TIMEOUT_MS, 240_000),
    /**
     * "auto" negotiates JSON mode on first use. Set "text" for servers that
     * reject `json_object` (LM Studio) to skip the wasted probe call.
     */
    responseFormat: str(process.env.OPENAI_RESPONSE_FORMAT, "auto"),
  },
  /**
   * Control over a local LM Studio runtime.
   *
   * Planning (an LLM) and generation (a diffusion model) both want the GPU, and
   * a 16 GB card cannot hold both — LM Studio keeps its model resident long
   * after planning finishes, which starves WanGP and fails the render with an
   * out-of-memory hint. Being able to eject the planning model between phases
   * is the difference between the pipeline working and not.
   *
   * Loading and unloading go through LM Studio's `lms` CLI; status comes from
   * its REST API. Enabled whenever a local OpenAI-compatible base URL is
   * configured, and can be forced off with LLM_RUNTIME_CONTROL_ENABLED=false.
   */
  llmRuntime: {
    enabled:
      bool(process.env.LLM_RUNTIME_CONTROL_ENABLED, true) &&
      Boolean(str(process.env.OPENAI_BASE_URL, "")),
    /** `lms` is installed on PATH by LM Studio; override for unusual installs. */
    cliPath: str(process.env.LMSTUDIO_CLI_PATH, "lms"),
    /** Loading a large model off disk is slow; give it room before giving up. */
    timeoutMs: int(process.env.LMSTUDIO_CLI_TIMEOUT_MS, 600_000),
    /**
     * Evict the planning model before a batch run. Generating a whole project
     * is many minutes of GPU work, and starting it while an LLM holds the card
     * produces CUDA faults partway through rather than a clean refusal.
     */
    unloadBeforeBatch: bool(process.env.LLM_UNLOAD_BEFORE_BATCH, true),
  },
  media: {
    /**
     * Render the end frame with the start frame as a reference image.
     *
     * The two keyframes are independent text-to-image jobs, so any detail the
     * prompt leaves unstated is reinvented between them — wardrobe drifts the
     * hardest. Showing the end-frame render what it has to match holds clothing,
     * styling and set dressing steady while the prompt still drives the change
     * in framing and action. Needs an image model that accepts references.
     */
    endFrameReferencesStartFrame: bool(process.env.END_FRAME_REFERENCES_START_FRAME, true),
    /**
     * Append a selected LoRA's trigger words to the prompt when they are absent.
     *
     * Many LoRAs are inert unless a trained word appears in the prompt, which
     * makes "I selected it and nothing changed" the usual first experience.
     * Only missing words are added, so a prompt that already names the trigger
     * is untouched. Turn off to manage trigger words by hand.
     */
    appendLoraTriggerWords: bool(process.env.LORA_APPEND_TRIGGER_WORDS, true),
  },
  sceneQueue: {
    /**
     * Extra attempts for a scene that fails with a transient GPU fault.
     *
     * "CUDA error: resource already mapped" and out-of-memory are symptoms of
     * memory pressure while WanGP swaps between the image and video models, not
     * of a bad request — the same scene usually succeeds on a second pass.
     * Losing an hour of queued work to one blip is the worse outcome.
     */
    retryAttempts: int(process.env.SCENE_QUEUE_RETRY_ATTEMPTS, 1),
    retryDelayMs: int(process.env.SCENE_QUEUE_RETRY_DELAY_MS, 20_000),
    /** Pause between scenes so WanGP can release VRAM before the next load. */
    settleDelayMs: int(process.env.SCENE_QUEUE_SETTLE_DELAY_MS, 5_000),
  },
} as const;

export { bool };
