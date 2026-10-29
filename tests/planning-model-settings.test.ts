// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { PLANNING_MODELS } from "@/lib/schemas/planning-model-settings";

const { runLms } = vi.hoisted(() => ({ runLms: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: runLms,
  }),
}));

const DEFAULT_MODEL = "environment-planner";
const MODEL_A = PLANNING_MODELS[0];
const MODEL_B = PLANNING_MODELS[3];
let dir: string;
const servers: Server[] = [];

type LlmRequest = {
  model: string;
  response_format?: { type: string };
  messages: { role: string; content: unknown }[];
};

async function endpoint(options: {
  rejectFormatsFor?: string;
  beforeReply?: () => Promise<void>;
  loadedModel?: string;
} = {}) {
  const requests: LlmRequest[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: options.loadedModel, state: "loaded" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const body = JSON.parse(raw) as LlmRequest;
    requests.push(body);
    await options.beforeReply?.();
    if (body.model === options.rejectFormatsFor && body.response_format?.type !== "text") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
  return requests;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-planning-model-"));
  vi.stubEnv("STORYFORGE_DATA_DIR", dir);
  vi.stubEnv("OPENAI_MODEL", DEFAULT_MODEL);
  vi.stubEnv("OPENAI_VISION_MODEL", "vision-planner");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("OPENAI_API_KEY", "local-test");
  vi.stubEnv("OPENAI_RESPONSE_FORMAT", "auto");
  vi.stubEnv("AI_PLANNING_ENABLED", "true");
  vi.stubEnv("LLM_RUNTIME_CONTROL_ENABLED", "true");
  vi.stubEnv("LMSTUDIO_CLI_PATH", "test-lms");
  runLms.mockReset().mockResolvedValue({ stdout: "loaded", stderr: "" });
  vi.resetModules();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  vi.unstubAllEnvs();
  vi.resetModules();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("app-wide planning model settings", () => {
  it("uses OPENAI_MODEL by default and the built-in default when unset", async () => {
    const { getPlanningModelSettings } = await import("@/lib/services/planning-model-settings-service");
    expect(await getPlanningModelSettings()).toEqual({
      version: 2,
      model: null,
      stages: { storyboard: null, agentic_canvas: null, render_prompts: null },
      defaultModel: DEFAULT_MODEL,
      effectiveModel: DEFAULT_MODEL,
      effectiveStages: {
        storyboard: DEFAULT_MODEL, agentic_canvas: DEFAULT_MODEL, render_prompts: DEFAULT_MODEL,
      },
    });
    vi.stubEnv("OPENAI_MODEL", "");
    vi.resetModules();
    const service = await import("@/lib/services/planning-model-settings-service");
    expect(await service.getPlanningModel()).toBe("gpt-4o-mini");
  });

  it("persists each of the six presets across module reloads and can restore the default", async () => {
    const { savePlanningModelSettings } = await import("@/lib/services/planning-model-settings-service");
    expect(PLANNING_MODELS).toHaveLength(6);
    for (const model of PLANNING_MODELS) {
      await savePlanningModelSettings({ model });
      vi.resetModules();
      const service = await import("@/lib/services/planning-model-settings-service");
      expect(await service.getPlanningModel()).toBe(model);
    }
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: null });
    expect(await service.getPlanningModel()).toBe(DEFAULT_MODEL);
    vi.stubEnv("OPENAI_MODEL", "new-environment-default");
    vi.resetModules();
    const reloaded = await import("@/lib/services/planning-model-settings-service");
    expect(await reloaded.getPlanningModel()).toBe("new-environment-default");
  });

  it("rejects malformed or unknown choices without changing the saved model", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: MODEL_A });
    for (const input of [{}, null, { model: "" }, { model: "--all" }, { model: 42 },
      { model: MODEL_B, baseUrl: "http://example.invalid" }]) {
      await expect(service.savePlanningModelSettings(input)).rejects.toThrow();
    }
    expect(await service.getPlanningModel()).toBe(MODEL_A);
  });

  it("serializes concurrent saves into a complete, readable record", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    await Promise.all(PLANNING_MODELS.map((model) => service.savePlanningModelSettings({ model })));
    expect(await service.getPlanningModel()).toBe(PLANNING_MODELS.at(-1));
  });

  it("surfaces corrupt settings instead of silently choosing another model", async () => {
    await fs.mkdir(path.join(dir, "library"));
    await fs.writeFile(path.join(dir, "library", "planning-model-settings.json"), "not json");
    const service = await import("@/lib/services/planning-model-settings-service");
    await expect(service.getPlanningModel()).rejects.toThrow(/settings are invalid/i);
    const { GET } = await import("@/app/api/settings/planning-model/route");
    expect((await GET()).status).toBe(500);
  });

  it("provides an uncached settings API with validation and no connection secrets", async () => {
    const { GET, PUT } = await import("@/app/api/settings/planning-model/route");
    const initial = await GET();
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({
      settings: {
        version: 2,
        model: null,
        stages: { storyboard: null, agentic_canvas: null, render_prompts: null },
        defaultModel: DEFAULT_MODEL,
        effectiveModel: DEFAULT_MODEL,
        effectiveStages: {
          storyboard: DEFAULT_MODEL, agentic_canvas: DEFAULT_MODEL, render_prompts: DEFAULT_MODEL,
        },
      },
      available: [],
    });
    const request = (model: unknown) => new Request("http://localhost/api/settings/planning-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const saved = await PUT(request(MODEL_B));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect((await saved.json()).settings.effectiveModel).toBe(MODEL_B);
    expect((await PUT(request("--all"))).status).toBe(400);
    const reset = await PUT(request(null));
    expect((await reset.json()).settings.effectiveModel).toBe(DEFAULT_MODEL);
  });
});

describe("planning model consumers", () => {
  it("uses the current choice on actual completion requests and provenance without recreating the provider", async () => {
    const requests = await endpoint();
    const service = await import("@/lib/services/planning-model-settings-service");
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const provider = getPlanningProvider()!;
    const generate = () => provider.generate!("Test agent", "Test request", z.object({ ok: z.boolean() }));

    expect(await generate()).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    await service.savePlanningModelSettings({ model: MODEL_A });
    expect(await generate()).toMatchObject({ ok: true, model: MODEL_A });
    await service.savePlanningModelSettings({ model: MODEL_B });
    expect(await generate()).toMatchObject({ ok: true, model: MODEL_B });
    await service.savePlanningModelSettings({ model: null });
    expect(await generate()).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    expect(requests.map((request) => request.model)).toEqual([
      DEFAULT_MODEL, MODEL_A, MODEL_B, DEFAULT_MODEL,
    ]);
  });

  it("keeps the separate vision model and its image attachments unchanged", async () => {
    const requests = await endpoint();
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: MODEL_A });
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const result = await getPlanningProvider()!.generate!(
      "Vision agent", "Inspect image", z.object({ ok: z.boolean() }),
      { images: ["data:image/png;base64,test"] },
    );
    expect(result).toMatchObject({ ok: true, model: "vision-planner" });
    expect(requests[0]?.model).toBe("vision-planner");
    expect(requests[0]?.messages[1]?.content).toEqual([
      { type: "text", text: "Inspect image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,test" } },
    ]);
  });

  it("does not carry one model's response-format failures over to a different model", async () => {
    const requests = await endpoint({ rejectFormatsFor: MODEL_A });
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: MODEL_A });
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const provider = getPlanningProvider()!;
    const generate = () => provider.generate!("Test agent", "Test request", z.object({ ok: z.boolean() }));
    expect(await generate()).toMatchObject({ ok: true, format: "text" });
    await service.savePlanningModelSettings({ model: MODEL_B });
    expect(await generate()).toMatchObject({ ok: true, format: "json_schema" });
    await service.savePlanningModelSettings({ model: MODEL_A });
    expect(await generate()).toMatchObject({ ok: true, format: "text" });
    expect(requests.map((request) => request.response_format?.type)).toEqual([
      "json_schema", "json_object", "text", "json_schema", "text",
    ]);
  });

  it("does not change an in-flight request when a new model is saved", async () => {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { arrived = resolve; });
    const requests = await endpoint({ beforeReply: async () => { arrived(); await gate; } });
    const service = await import("@/lib/services/planning-model-settings-service");
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const result = getPlanningProvider()!.generate!("Test", "Test", z.object({ ok: z.boolean() }));
    await seen;
    try {
      await service.savePlanningModelSettings({ model: MODEL_B });
    } finally {
      release();
    }
    expect(await result).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    expect(requests[0]?.model).toBe(DEFAULT_MODEL);
  });

  it("uses the saved model for LM Studio status and the Load for planning command", async () => {
    await endpoint({ loadedModel: MODEL_B });
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: MODEL_B });
    const { getLlmRuntimeStatus, loadPlanningModel } = await import("@/lib/services/llm-runtime-service");
    expect(await getLlmRuntimeStatus()).toMatchObject({
      configuredModel: MODEL_B, configuredModelLoaded: true, reachable: true,
    });
    await loadPlanningModel();
    expect(runLms).toHaveBeenCalledWith("test-lms", ["load", MODEL_B, "-y"], expect.any(Object));
    await service.savePlanningModelSettings({ model: null });
    await loadPlanningModel();
    expect(runLms).toHaveBeenLastCalledWith(
      "test-lms", ["load", DEFAULT_MODEL, "-y"], expect.any(Object),
    );
  });
});
