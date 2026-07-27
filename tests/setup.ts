import "@testing-library/jest-dom";

/**
 * Pin the external-integration flags off before any module reads config.
 *
 * Vitest inherits the shell environment, so a developer who has been running
 * live generation still has WANGP_MCP_ENABLED / AI_PLANNING_ENABLED exported.
 * Without this the suite silently swaps in the live clients and fails inside
 * the MCP transport ("Expected signal to be an instance of AbortSignal"),
 * which looks like a code regression rather than leaked environment.
 *
 * FFMPEG_ENABLED is deliberately left alone: several tests exercise the native
 * runner against real ffmpeg on purpose.
 */
process.env.WANGP_MCP_ENABLED = "false";
process.env.AI_PLANNING_ENABLED = "false";

/**
 * Projects now persist to disk by default. Tests must not write into the real
 * data directory: it would leave stray records behind, make runs order
 * dependent, and slow every case down with filesystem I/O.
 */
process.env.STORYFORGE_PERSISTENCE = "memory";

/**
 * The scene queue paces itself in production — it waits between scenes so the
 * GPU can release the previous model, and backs off before retrying a
 * transient fault. Neither is meaningful against the mock client, and both
 * would add real seconds to every queue test.
 */
process.env.SCENE_QUEUE_SETTLE_DELAY_MS = "0";
process.env.SCENE_QUEUE_RETRY_DELAY_MS = "0";
