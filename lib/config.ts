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

export type PersistenceMode = "memory" | "prisma";

const persistence: PersistenceMode =
  str(process.env.STORYFORGE_PERSISTENCE, "memory") === "prisma" ? "prisma" : "memory";

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
} as const;

export { bool };
