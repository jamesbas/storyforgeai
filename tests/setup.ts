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
