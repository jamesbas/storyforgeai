import "@testing-library/jest-dom";
import os from "node:os";
import path from "node:path";

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
 * Point the data directory at a throwaway location.
 *
 * `STORYFORGE_PERSISTENCE=memory` only isolates the *project* repository. The
 * character library is deliberately durable regardless of that setting — it is
 * curated configuration, not disposable session state — so it writes to
 * `config.dataDir` either way. Without this, any test touching a character
 * writes into the real library, and a suite that creates a character per case
 * quietly fills it with duplicates and orphaned uploads.
 *
 * Tests needing their own isolated root still create one; this only stops the
 * default from being someone's actual data.
 */
process.env.STORYFORGE_DATA_DIR = path.join(os.tmpdir(), "storyforge-test-data");

/**
 * The scene queue paces itself in production — it waits between scenes so the
 * GPU can release the previous model, and backs off before retrying a
 * transient fault. Neither is meaningful against the mock client, and both
 * would add real seconds to every queue test.
 */
process.env.SCENE_QUEUE_SETTLE_DELAY_MS = "0";
process.env.SCENE_QUEUE_RETRY_DELAY_MS = "0";

/**
 * jsdom does not implement `<dialog>`: `showModal` and `close` are simply
 * absent, in 25 and in 27 alike. This shim gives them the open/close semantics
 * component tests need to check role, name, initial focus and focus
 * restoration.
 *
 * It deliberately does NOT fake modality, focus containment or Escape. jsdom
 * has no top layer, so pretending would prove nothing — those are asserted in
 * Playwright against a real browser instead.
 */
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
