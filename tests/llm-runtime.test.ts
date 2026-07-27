import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LM Studio runtime status.
 *
 * Load and unload shell out to the `lms` CLI and are covered by live use rather
 * than here — spawning a real process in unit tests would be slow and would
 * depend on LM Studio being installed. What is worth pinning is the status
 * shaping, because the UI decides whether to warn about a busy GPU from it, and
 * that an unreachable LM Studio degrades quietly instead of throwing.
 *
 * `config` reads process.env once at module load, so each case sets the
 * environment and then imports the service fresh.
 */

const BASE_URL = "http://127.0.0.1:1234/v1";
const MODEL = "test-planning-model";

async function loadService() {
  vi.resetModules();
  vi.stubEnv("OPENAI_BASE_URL", BASE_URL);
  vi.stubEnv("OPENAI_MODEL", MODEL);
  return import("@/lib/services/llm-runtime-service");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("LM Studio runtime status", () => {
  it("reports the loaded models and whether the configured one is among them", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: MODEL, state: "loaded" },
              { id: "some-other-model", state: "not-loaded" },
            ],
          }),
        } as unknown as Response;
      }),
    );

    const { getLlmRuntimeStatus } = await loadService();
    const status = await getLlmRuntimeStatus();

    // The native API lives beside the OpenAI-compatible one, not under /v1.
    expect(seen[0]).toBe("http://127.0.0.1:1234/api/v0/models");
    expect(status.enabled).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.loadedModels).toEqual([MODEL]);
    expect(status.configuredModelLoaded).toBe(true);
  });

  it("reports an empty set once everything is unloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: MODEL, state: "not-loaded" }] }),
      })) as unknown as typeof fetch,
    );

    const { getLlmRuntimeStatus } = await loadService();
    const status = await getLlmRuntimeStatus();
    expect(status.loadedModels).toEqual([]);
    expect(status.configuredModelLoaded).toBe(false);
  });

  it("degrades quietly when LM Studio is not running", async () => {
    // A shut LM Studio is a normal state, not an error: the storyboard screen
    // must still render rather than surfacing a failure.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );

    const { getLlmRuntimeStatus } = await loadService();
    const status = await getLlmRuntimeStatus();
    expect(status.reachable).toBe(false);
    expect(status.loadedModels).toEqual([]);
  });

  it("stays disabled when no local LLM server is configured", async () => {
    vi.resetModules();
    vi.stubEnv("OPENAI_BASE_URL", "");
    const { getLlmRuntimeStatus } = await import("@/lib/services/llm-runtime-service");
    const status = await getLlmRuntimeStatus();
    expect(status.enabled).toBe(false);
    expect(status.reachable).toBe(false);
  });
});
