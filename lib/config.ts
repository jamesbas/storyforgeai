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
    deepyAssist: bool(process.env.DEEPY_ASSIST_ENABLED, false),
    animaticAssembly: bool(process.env.ANIMATIC_ASSEMBLY_ENABLED, false),
    platformDerivatives: bool(process.env.PLATFORM_DERIVATIVES_ENABLED, false),
  },
  wangp: {
    url: str(process.env.WANGP_MCP_URL, "http://127.0.0.1:7866/mcp"),
    outputDir: str(process.env.WANGP_OUTPUT_DIR, ""),
  },
  openai: {
    apiKey: str(process.env.OPENAI_API_KEY, ""),
    model: str(process.env.OPENAI_MODEL, "gpt-4o-mini"),
  },
} as const;

export { bool };
