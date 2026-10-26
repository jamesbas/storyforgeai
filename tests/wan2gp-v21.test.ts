import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveWangpClient } from "@/lib/wangp/live-client";
import { normalizeJob } from "@/lib/wangp/mcp/normalize";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";

afterEach(() => vi.restoreAllMocks());

function completedJob(galleryItems: Record<string, unknown>[]) {
  return {
    job_id: "job-21",
    done: true,
    status: "done",
    result: { success: true, cancelled: false, errors: [], gallery_items: galleryItems },
  };
}

function liveClient(snapshot: unknown, info: Record<string, unknown> = {}) {
  vi.spyOn(WangpMcpTransport.prototype, "findTool").mockResolvedValue("wangp_models");
  vi.spyOn(WangpMcpTransport.prototype, "getToolInputSchema").mockResolvedValue({
    properties: { settings: {}, wait: { type: "boolean", const: true } },
  });
  const call = vi.spyOn(WangpMcpTransport.prototype, "call").mockImplementation(async (name, args) => {
    if (name === "wangp_model") {
      if (args?.action === "defaults") return { defaults: { model_type: "demo", prompt: "" } };
      if (args?.action === "capabilities") return { metadata: { model_type: "demo" } };
      return { definition: { setting_values: { prompt: {} } } };
    }
    if (name === "wangp_generate" || (name === "wangp_session" && args?.action === "get_job")) {
      return snapshot;
    }
    if (name === "wangp_io" && args?.action === "info") {
      return info[String((args.arguments as Record<string, unknown>).path)];
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  return { client: new LiveWangpClient("http://127.0.0.1:1/mcp"), call };
}

describe("WanGP MCP v2.1 output delivery", () => {
  it("keeps the absolute Gallery path returned by the live v2.1 server", async () => {
    const { client, call } = liveClient(completedJob([{
      media_id: "visual:6cd5d5cbde3a",
      media_type: "image",
      role: "final",
      path: "C:\\outputs\\storyforge-mcp-v21-check.jpg",
    }]));

    await expect(client.getJob("job-21")).resolves.toMatchObject({
      generatedFiles: ["C:\\outputs\\storyforge-mcp-v21-check.jpg"],
    });
    expect(call.mock.calls.some(([name]) => name === "wangp_io")).toBe(false);
  });

  it("resolves compact image, video and audio Gallery IDs and excludes intermediate outputs", async () => {
    const snapshot = completedJob([
      { media_id: "visual:intermediate", media_type: "video", role: "intermediate" },
      { media_id: "visual:frame", media_type: "image", role: "final" },
      { media_id: "visual:clip", media_type: "video", role: "final" },
      { media_id: "audio:sound", media_type: "audio", role: "final" },
    ]);
    const { client, call } = liveClient(snapshot, {
      "visual:frame": { status: "done", path: "C:\\outputs\\frame.jpg" },
      "visual:clip": { status: "done", path: "C:\\outputs\\clip.mp4" },
      "audio:sound": { status: "done", path: "C:\\outputs\\sound.wav" },
    });

    const job = await client.getJob("job-21");

    expect(job).toMatchObject({
      id: "job-21",
      status: "completed",
      progress: 100,
      generatedFiles: ["C:\\outputs\\frame.jpg", "C:\\outputs\\clip.mp4", "C:\\outputs\\sound.wav"],
    });
    expect(call.mock.calls.filter(([name]) => name === "wangp_io")).toEqual([
      ["wangp_io", { action: "info", arguments: { path: "visual:frame" } }],
      ["wangp_io", { action: "info", arguments: { path: "visual:clip" } }],
      ["wangp_io", { action: "info", arguments: { path: "audio:sound" } }],
    ]);
    expect(snapshot.result).not.toHaveProperty("generated_files");
  });

  it("delivers a compact result returned by the initial synchronous generation call", async () => {
    const { client } = liveClient(completedJob([{ media_id: "visual:frame" }]), {
      "visual:frame": { status: "done", path: "C:\\outputs\\frame.jpg" },
    });

    await expect(client.generate({ model_type: "demo", prompt: "frame" })).resolves.toMatchObject({
      status: "completed",
      generatedFiles: ["C:\\outputs\\frame.jpg"],
    });
  });

  it("resolves virtual output references through the server instead of guessing a local folder", async () => {
    const { client } = liveClient(completedJob([{ path: "@outputs\\workspace\\frame.jpg" }]), {
      "@outputs\\workspace\\frame.jpg": { status: "done", path: "D:\\workspace\\frame.jpg" },
    });

    await expect(client.getJob("job-21")).resolves.toMatchObject({
      generatedFiles: ["D:\\workspace\\frame.jpg"],
    });
  });

  it("does not reinterpret legacy filesystem output paths", async () => {
    const { client, call } = liveClient({
      job_id: "legacy",
      done: true,
      result: { success: true, generated_files: ["C:\\outputs\\frame.jpg"], errors: [] },
    });

    await expect(client.getJob("legacy")).resolves.toMatchObject({
      generatedFiles: ["C:\\outputs\\frame.jpg"],
    });
    expect(call.mock.calls.some(([name]) => name === "wangp_io")).toBe(false);
  });

  it("surfaces a failed file lookup instead of returning a successful job with no image", async () => {
    const { client } = liveClient(completedJob([{ media_id: "visual:missing" }]), {
      "visual:missing": { status: "error", error: "File no longer exists" },
    });

    await expect(client.getJob("job-21")).rejects.toThrow(/File no longer exists/);
  });

  it("explains filesystem permissions when file info still returns a virtual path", async () => {
    const { client } = liveClient(completedJob([{ media_id: "visual:frame" }]), {
      "visual:frame": { status: "done", path: "@outputs\\frame.jpg" },
    });

    await expect(client.getJob("job-21")).rejects.toThrow(/--mcp-allow-read-file-system/);
  });

  it("refuses an output-less success instead of silently losing the render", async () => {
    const { client } = liveClient(completedJob([]));

    await expect(client.getJob("job-21")).rejects.toThrow(/completed.*no.*output/i);
  });
});

describe("WanGP MCP v2.1 compact model discovery", () => {
  it("enriches compact search rows, follows short cursor pages, and skips unsupported mesh outputs", async () => {
    vi.spyOn(WangpMcpTransport.prototype, "findTool").mockResolvedValue("wangp_models");
    const call = vi.spyOn(WangpMcpTransport.prototype, "call").mockImplementation(async (name, args) => {
      if (name === "wangp_models") {
        const cursor = (args?.arguments as Record<string, unknown>).cursor;
        return cursor
          ? { models: [{ model_type: "ltx2" }], has_more: false }
          : {
              models: [{ model_type: "mesh" }, { model_type: "krea2" }],
              has_more: true,
              next_cursor: "page-2",
            };
      }
      if (name === "wangp_model") {
        const modelType = args?.model_type;
        return {
          metadata: {
            model_type: modelType,
            main_output: [modelType === "mesh" ? "mesh" : modelType === "krea2" ? "image" : "video"],
            capabilities: ["lora"],
            media_inputs: { image: modelType === "krea2" ? ["reference"] : ["start", "end"] },
          },
        };
      }
      throw new Error(`Unexpected tool ${name}`);
    });
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");

    expect((await client.listModels()).map((model) => model.modelType)).toEqual(["krea2", "ltx2"]);
    expect((await client.listModels("image"))[0]?.metadata.mediaInputs?.image?.reference).toBe(true);
    expect((await client.listModels("video"))[0]?.metadata.mediaInputs?.image?.end).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === "wangp_models")).toHaveLength(2);
  });
});

describe("WanGP MCP v2.1 compact job state", () => {
  it("uses snapshot progress without an event log and derives the phase percentage from steps", () => {
    expect(normalizeJob({
      job_id: "running",
      done: false,
      progress: { phase: "inference", current_step: 6, total_steps: 8, progress: 40 },
      result: null,
    })).toMatchObject({ status: "running", progress: 75 });
  });

  it("recognizes a running phase even before it has a known step count", () => {
    expect(normalizeJob({
      job_id: "loading",
      done: false,
      progress: { phase: "loading_model", current_step: null, total_steps: null, progress: 0 },
    })).toMatchObject({ status: "running", progress: 0 });
  });

  it.each([
    ["done", "completed"],
    ["error", "failed"],
    ["interrupted", "cancelled"],
  ])("maps compact terminal status %s without a result", (status, expected) => {
    expect(normalizeJob({ job_id: "terminal", status })).toMatchObject({ status: expected });
  });

  it("does not mistake an incomplete restart receipt for a queued or completed job", () => {
    expect(() => normalizeJob({
      job_id: "lost",
      done: false,
      status: "unknown_after_restart",
      recovered_outputs: [{ media_id: "visual:partial" }],
      note: "Completion could not be established.",
    })).toThrow(/unknown.*restart/i);
  });

  it("keeps a failed result failed even if a recovered receipt has status done", () => {
    expect(normalizeJob({
      job_id: "failed",
      done: true,
      status: "done",
      result: { success: false, errors: [{ message: "Out of memory" }] },
    })).toMatchObject({ status: "failed", errors: ["Out of memory"] });
  });
});
