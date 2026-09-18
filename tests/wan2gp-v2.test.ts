import { describe, expect, it } from "vitest";
import { LiveWangpClient } from "@/lib/wangp/live-client";

type Call = { name: string; args: Record<string, unknown> };
type CallOptions = { timeout?: number };

function v2Client() {
  const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
  const calls: Call[] = [];
  const transport = {
    findTool: async (candidates: string[]) =>
      candidates.find((candidate) => candidate === "wangp_models"),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (name !== "wangp_models") throw new Error(`Unexpected tool ${name}`);

      const request = args.arguments as Record<string, unknown>;
      if (request.cursor === "page-2") {
        return {
          models: [
            {
              model_type: "ltx2_22B_distilled_1_1",
              name: "LTX-2 Distilled",
              main_output: "video",
              outputs: ["video", "audio"],
              capabilities: ["image_to_video", "lora"],
              media_inputs: { image: ["start", "end"] },
            },
          ],
          count: 1,
          has_more: false,
          next_cursor: null,
        };
      }

      return {
        models: [
          {
            model_type: "krea2_raw_edit",
            name: "Krea 2 Raw Edit",
            main_output: "image",
            outputs: ["image"],
            capabilities: ["text_to_image", "reference_images", "lora"],
            media_inputs: {
              image: ["reference", "multiple_references", "background", "mask"],
            },
          },
        ],
        count: 1,
        has_more: true,
        next_cursor: "page-2",
      };
    },
  };
  (client as unknown as { transport: typeof transport }).transport = transport;
  return { client, calls };
}

describe("WanGP MCP v2", () => {
  it("discovers every cursor page and normalizes flat capabilities", async () => {
    const { client, calls } = v2Client();

    const models = await client.listModels();

    expect(models.map((model) => model.modelType)).toEqual([
      "krea2_raw_edit",
      "ltx2_22B_distilled_1_1",
    ]);
    expect(models[0]!.metadata.supportsLora).toBe(true);
    expect(models[0]!.metadata.mediaInputs?.image?.reference).toBe(true);
    expect(models[1]!.metadata.mediaInputs?.image?.start).toBe(true);
    expect(models[1]!.metadata.mediaInputs?.image?.end).toBe(true);
    expect(calls).toEqual([
      {
        name: "wangp_models",
        args: { action: "search", arguments: { limit: 100 } },
      },
      {
        name: "wangp_models",
        args: { action: "search", arguments: { limit: 100, cursor: "page-2" } },
      },
    ]);
  });

  it("combines capabilities, definition, and defaults into a generation schema", async () => {
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
    const calls: Call[] = [];
    const transport = {
      findTool: async (candidates: string[]) =>
        candidates.find((candidate) => candidate === "wangp_models"),
      call: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        if (name !== "wangp_model") throw new Error(`Unexpected tool ${name}`);
        if (args.action === "capabilities") {
          return {
            metadata: {
              model_type: "krea2_raw_edit",
              main_output: "image",
              capabilities: ["text_to_image", "reference_images", "lora"],
              media_inputs: { image: ["reference", "mask"] },
            },
          };
        }
        if (args.action === "definition") {
          return {
            definition: {
              setting_values: {
                resolution: { choices: ["1024x1024", "1280x720"] },
              },
              sample_solvers: ["euler"],
            },
          };
        }
        if (args.action === "defaults") {
          return {
            defaults: {
              model_type: "krea2_raw_edit",
              prompt: "",
              resolution: "1024x1024",
              image_refs: [],
            },
          };
        }
        throw new Error(`Unexpected action ${String(args.action)}`);
      },
    };
    (client as unknown as { transport: typeof transport }).transport = transport;

    const schema = await client.getModelSchema("krea2_raw_edit");

    expect(schema.defaultSettings.resolution).toBe("1024x1024");
    expect(schema.fields.find((field) => field.name === "resolution")?.allowed).toEqual([
      "1024x1024",
      "1280x720",
    ]);
    expect(schema.fields.find((field) => field.name === "image_refs")).toBeDefined();
    expect(calls.map(({ args }) => args)).toEqual([
      { model_type: "krea2_raw_edit", action: "capabilities", arguments: {} },
      { model_type: "krea2_raw_edit", action: "definition", arguments: {} },
      { model_type: "krea2_raw_edit", action: "defaults", arguments: {} },
    ]);
  });

  it("waits for a terminal result when asynchronous generation is disabled", async () => {
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
    const calls: Array<Call & { options?: CallOptions }> = [];
    const transport = {
      findTool: async (candidates: string[]) =>
        candidates.find((candidate) => candidate === "wangp_models"),
      call: async (name: string, args: Record<string, unknown> = {}, options?: CallOptions) => {
        calls.push({ name, args, options });
        if (name === "wangp_model") {
          if (args.action === "defaults") return { defaults: { model_type: "demo", prompt: "" } };
          if (args.action === "capabilities") return { metadata: { model_type: "demo" } };
          return { definition: { setting_values: { prompt: {} } } };
        }
        if (name === "wangp_generate" && args.arguments === null) {
          return { properties: { wait: { type: "boolean", default: true, const: true } } };
        }
        if (name === "wangp_generate") {
          return {
            job_id: "sync-1",
            done: true,
            result: { success: true, generated_files: ["C:/out/frame.png"], errors: [] },
            events: [],
          };
        }
        throw new Error(`Unexpected tool ${name}`);
      },
    };
    (client as unknown as { transport: typeof transport }).transport = transport;

    const job = await client.generate({ model_type: "demo", prompt: "frame" });

    expect(job).toMatchObject({ id: "sync-1", status: "completed", progress: 100 });
    expect(job.generatedFiles).toEqual(["C:/out/frame.png"]);
    expect(calls.at(-1)).toEqual({
      name: "wangp_generate",
      args: {
        action: "generate",
        arguments: {
          source: { model_type: "demo", prompt: "frame" },
          wait: true,
          timeout_s: 30,
          event_limit: 20,
        },
      },
      options: { timeout: 45_000 },
    });
  });

  it("returns a resumable job when the initial synchronous wait times out", async () => {
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
    const transport = {
      findTool: async () => "wangp_models",
      call: async (name: string, args: Record<string, unknown> = {}) => {
        if (name === "wangp_model") {
          if (args.action === "defaults") return { defaults: { model_type: "demo", prompt: "" } };
          if (args.action === "capabilities") return { metadata: { model_type: "demo" } };
          return { definition: { setting_values: { prompt: {} } } };
        }
        if (name === "wangp_generate" && args.arguments === null) {
          return { action: { parameters: { properties: { wait: { const: true } } } } };
        }
        return {
          job_id: "sync-running-1",
          done: false,
          status: "timeout",
          waiting_timed_out: true,
          events: [{ kind: "progress", data: { progress: 27 } }],
          result: null,
        };
      },
    };
    (client as unknown as { transport: typeof transport }).transport = transport;

    await expect(client.generate({ model_type: "demo", prompt: "frame" })).resolves.toMatchObject({
      id: "sync-running-1",
      status: "running",
      progress: 27,
      generatedFiles: [],
    });
  });

  it("submits and manages a v2 session when asynchronous generation is enabled", async () => {
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
    const calls: Call[] = [];
    const transport = {
      findTool: async (candidates: string[]) =>
        candidates.find((candidate) => candidate === "wangp_models"),
      call: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        if (name === "wangp_model") {
          if (args.action === "defaults") return { defaults: { model_type: "demo", prompt: "" } };
          if (args.action === "capabilities") return { metadata: { model_type: "demo" } };
          return { definition: { setting_values: { prompt: {} } } };
        }
        if (name === "wangp_generate" && args.arguments === null) {
          return { properties: { wait: { type: "boolean", default: true } } };
        }
        if (name === "wangp_generate") return { job_id: "async-1" };
        if (name === "wangp_session" && args.action === "get_job") {
          return { job_id: "async-1", done: false, events: [], result: null };
        }
        if (name === "wangp_session" && args.action === "cancel_job") return { cancelled: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    };
    (client as unknown as { transport: typeof transport }).transport = transport;

    await expect(client.generate({ model_type: "demo", prompt: "clip" })).resolves.toMatchObject({
      id: "async-1",
      status: "submitted",
    });
    await expect(client.getJob("async-1")).resolves.toMatchObject({ status: "submitted" });
    await expect(client.cancelJob("async-1")).resolves.toMatchObject({ status: "cancelled" });

    expect(calls.some(({ name, args }) =>
      name === "wangp_generate" &&
      (args.arguments as Record<string, unknown> | null)?.wait === false,
    )).toBe(true);
    expect(calls.some(({ name, args }) =>
      name === "wangp_session" && args.action === "get_job",
    )).toBe(true);
    expect(calls.some(({ name, args }) =>
      name === "wangp_session" && args.action === "cancel_job",
    )).toBe(true);
  });
});