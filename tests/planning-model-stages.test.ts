// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { z } from "zod";

const DEFAULT_MODEL = "environment-planner";
const STORY = "brand-new-27b@q4_k_m";
const PROMPTS = "tiny-9b";
let dir: string;
const servers: Server[] = [];

async function endpoint() {
  const requests: { model: string }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({
        data: [
          { id: "installed-llm", type: "llm", state: "not-loaded" },
          { id: "installed-vlm", type: "vlm", state: "loaded" },
          { id: "embedder", type: "embeddings", state: "not-loaded" },
        ],
      }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    requests.push(JSON.parse(raw) as { model: string });
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-stage-models-"));
  vi.stubEnv("STORYFORGE_DATA_DIR", dir);
  vi.stubEnv("OPENAI_MODEL", DEFAULT_MODEL);
  vi.stubEnv("OPENAI_VISION_MODEL", "vision-planner");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("OPENAI_API_KEY", "local-test");
  vi.stubEnv("OPENAI_RESPONSE_FORMAT", "auto");
  vi.stubEnv("AI_PLANNING_ENABLED", "true");
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

describe("per-stage planning models", () => {
  it("falls back to the planning model for every stage until one is set", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    expect(await service.getPlanningModel("storyboard")).toBe(DEFAULT_MODEL);
    await service.savePlanningModelSettings({ model: "chosen-default" });
    expect(await service.getPlanningModel("render_prompts")).toBe("chosen-default");
    expect(await service.getPlanningModel()).toBe("chosen-default");
  });

  it("accepts any model id the server knows, not only the presets", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    const saved = await service.savePlanningModelSettings({
      model: null, stages: { storyboard: STORY, render_prompts: PROMPTS },
    });
    expect(saved.effectiveStages).toEqual({
      storyboard: STORY, agentic_canvas: DEFAULT_MODEL, render_prompts: PROMPTS,
    });
    expect(await service.getPlanningModel("storyboard")).toBe(STORY);
    expect(await service.getPlanningModel("agentic_canvas")).toBe(DEFAULT_MODEL);
  });

  it("keeps a stage that a later save does not mention, and clears one set to null", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({
      model: null, stages: { storyboard: STORY, render_prompts: PROMPTS },
    });
    await service.savePlanningModelSettings({ model: "other-default" });
    expect(await service.getPlanningModel("storyboard")).toBe(STORY);
    await service.savePlanningModelSettings({ model: null, stages: { storyboard: null } });
    expect(await service.getPlanningModel("storyboard")).toBe(DEFAULT_MODEL);
    expect(await service.getPlanningModel("render_prompts")).toBe(PROMPTS);
  });

  it("rejects an id that could be read as a command-line option", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    for (const bad of ["--all", "-y", "a b", "model;rm", ""]) {
      await expect(
        service.savePlanningModelSettings({ model: null, stages: { storyboard: bad } }),
      ).rejects.toThrow();
    }
    await expect(
      service.savePlanningModelSettings({ model: null, stages: { unknown_stage: "x" } }),
    ).rejects.toThrow();
  });

  it("reads a settings file from the first release as that one model for everything", async () => {
    await fs.mkdir(path.join(dir, "library"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "library", "planning-model-settings.json"),
      JSON.stringify({ version: 1, model: "qwen3.8-27b-heretic-ara-16gb-vram-xs-mtp" }),
    );
    const service = await import("@/lib/services/planning-model-settings-service");
    expect(await service.getPlanningModelSettings()).toMatchObject({
      version: 2,
      model: "qwen3.8-27b-heretic-ara-16gb-vram-xs-mtp",
      stages: { storyboard: null, agentic_canvas: null, render_prompts: null },
    });
    expect(await service.getPlanningModel("render_prompts")).toBe(
      "qwen3.8-27b-heretic-ara-16gb-vram-xs-mtp",
    );
  });

  it("serializes saves that each change one stage without losing either", async () => {
    const service = await import("@/lib/services/planning-model-settings-service");
    await Promise.all([
      service.savePlanningModelSettings({ model: null, stages: { storyboard: STORY } }),
      service.savePlanningModelSettings({ model: null, stages: { render_prompts: PROMPTS } }),
    ]);
    const settings = await service.getPlanningModelSettings();
    expect(settings.stages).toMatchObject({ render_prompts: PROMPTS });
    expect(settings.stages.storyboard === STORY || settings.stages.storyboard === null).toBe(true);
  });

  it("sends each call to its stage's model, and calls with no stage to the default", async () => {
    const requests = await endpoint();
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({
      model: null, stages: { storyboard: STORY, render_prompts: PROMPTS },
    });
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const provider = getPlanningProvider()!;
    const call = (scope?: "storyboard" | "agentic_canvas" | "render_prompts") =>
      provider.generate!("Agent", "Request", z.object({ ok: z.boolean() }), {
        systemPromptScope: scope,
      });

    expect(await call("storyboard")).toMatchObject({ ok: true, model: STORY });
    expect(await call("render_prompts")).toMatchObject({ ok: true, model: PROMPTS });
    expect(await call("agentic_canvas")).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    expect(await call()).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    expect(requests.map((r) => r.model)).toEqual([STORY, PROMPTS, DEFAULT_MODEL, DEFAULT_MODEL]);

    // Changing the saved stage applies to the next call without a new provider.
    await service.savePlanningModelSettings({ model: null, stages: { storyboard: null } });
    expect(await call("storyboard")).toMatchObject({ ok: true, model: DEFAULT_MODEL });
  });

  it("keeps images on the vision model whatever stage asked", async () => {
    await endpoint();
    const service = await import("@/lib/services/planning-model-settings-service");
    await service.savePlanningModelSettings({ model: null, stages: { storyboard: STORY } });
    const { getPlanningProvider } = await import("@/lib/agents/llm/provider");
    const result = await getPlanningProvider()!.generate!(
      "Vision", "Look", z.object({ ok: z.boolean() }),
      { images: ["data:image/png;base64,test"], systemPromptScope: "storyboard" },
    );
    expect(result).toMatchObject({ ok: true, model: "vision-planner" });
  });

  it("offers the server's text models as suggestions, without embedding models", async () => {
    await endpoint();
    const { GET } = await import("@/app/api/settings/planning-model/route");
    const body = await (await GET()).json();
    expect(body.available).toEqual(["installed-llm", "installed-vlm"]);
    expect(body.settings.effectiveStages.storyboard).toBe(DEFAULT_MODEL);
  });

  it("saves stages through the API and returns what each stage will use", async () => {
    const { PUT } = await import("@/app/api/settings/planning-model/route");
    const response = await PUT(new Request("http://localhost/api/settings/planning-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: null, stages: { storyboard: STORY } }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).settings.effectiveStages.storyboard).toBe(STORY);
    const bad = await PUT(new Request("http://localhost/api/settings/planning-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: null, stages: { storyboard: "--all" } }),
    }));
    expect(bad.status).toBe(400);
  });
});
