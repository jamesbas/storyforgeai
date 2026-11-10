import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LM Studio runtime status.
 *
 * The CLI is stubbed so handoff tests never touch a real model. Status shaping
 * drives the UI, and automatic unloading must finish and confirm free memory
 * before a live render can start.
 *
 * `config` reads process.env once at module load, so each case sets the
 * environment and then imports the service fresh.
 */

const BASE_URL = "http://127.0.0.1:1234/v1";
const MODEL = "test-planning-model";

const { runLms } = vi.hoisted(() => ({ runLms: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: runLms,
  });
  return { execFile, default: { execFile } };
});

async function loadService(autoUnload = true) {
  vi.resetModules();
  vi.stubEnv("OPENAI_BASE_URL", BASE_URL);
  vi.stubEnv("OPENAI_MODEL", MODEL);
  vi.stubEnv("LLM_RUNTIME_CONTROL_ENABLED", "true");
  vi.stubEnv("LLM_UNLOAD_BEFORE_BATCH", String(autoUnload));
  return import("@/lib/services/llm-runtime-service");
}

beforeEach(() => {
  vi.resetModules();
  runLms.mockReset().mockResolvedValue({ stdout: "Models unloaded.", stderr: "" });
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

  function modelsResponse(ids: string[]) {
    return new Response(JSON.stringify({
      data: ids.map((id) => ({ id, state: "loaded" })),
    }), { status: 200 });
  }

  describe("automatic planning-to-generation handoff", () => {
    it("unloads the model used for feedback even when it is not the configured planner", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(modelsResponse(["feedback-prompt-model"]))
        .mockResolvedValueOnce(modelsResponse([]));
      vi.stubGlobal("fetch", fetchMock);
      const { unloadPlanningModelForGeneration } = await loadService();

      expect(await unloadPlanningModelForGeneration()).toEqual(["feedback-prompt-model"]);
      expect(runLms).toHaveBeenCalledWith(
        expect.any(String), ["unload", "--all"], expect.any(Object),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not unload when automatic unloading is explicitly disabled", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { unloadPlanningModelForGeneration } = await loadService(false);
      expect(await unloadPlanningModelForGeneration()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runLms).not.toHaveBeenCalled();
    });

    it("does not contact LM Studio when runtime control is disabled", async () => {
      vi.stubEnv("OPENAI_BASE_URL", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { unloadPlanningModelForGeneration } = await import("@/lib/services/llm-runtime-service");
      expect(await unloadPlanningModelForGeneration()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runLms).not.toHaveBeenCalled();
    });

    it("leaves an already-empty runtime alone", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelsResponse([])));
      const { unloadPlanningModelForGeneration } = await loadService();
      expect(await unloadPlanningModelForGeneration()).toEqual([]);
      expect(runLms).not.toHaveBeenCalled();
    });

    it("leaves a stopped LM Studio alone", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const { unloadPlanningModelForGeneration } = await loadService();
      expect(await unloadPlanningModelForGeneration()).toEqual([]);
      expect(runLms).not.toHaveBeenCalled();
    });

    it("surfaces CLI failures instead of claiming the GPU was released", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelsResponse(["feedback-model"])));
      runLms.mockRejectedValue(new Error("Unload command failed."));
      const { unloadPlanningModelForGeneration } = await loadService();
      await expect(unloadPlanningModelForGeneration()).rejects.toThrow("Unload command failed.");
    });

    it("refuses generation if LM Studio still reports a loaded model", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(modelsResponse(["feedback-model"]))
        .mockResolvedValueOnce(modelsResponse(["feedback-model"]));
      vi.stubGlobal("fetch", fetchMock);
      const { unloadPlanningModelForGeneration } = await loadService();
      await expect(unloadPlanningModelForGeneration()).rejects.toThrow("still reports loaded models");
    });

    it("does not claim success when post-unload residency cannot be verified", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(modelsResponse(["feedback-model"]))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);
      const { unloadPlanningModelForGeneration } = await loadService();
      await expect(unloadPlanningModelForGeneration()).rejects.toThrow("Could not verify");
    });
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
