import { describe, it, expect } from "vitest";
import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * Discovery has to page.
 *
 * WanGP capped `wangp_list_models` at ten records per call and defaulted the
 * limit to ten. One unpaged request therefore returned the first ten model
 * types alphabetically — nine music models and one video model — and a
 * 217-model catalogue arrived as an empty picker with no error logged
 * anywhere, because every layer treats "not in the catalogue" as a fact.
 */

/** The server's own clamp: `max(1, min(limit, 10))`. */
const SERVER_PAGE_CAP = 10;

type Call = { name: string; args: Record<string, unknown> };

function catalogue(size: number) {
  return Array.from({ length: size }, (_, i) => ({
    model_type: `m${String(i).padStart(3, "0")}`,
    name: `Model ${i}`,
    main_output: ["image"],
    media_inputs: { image: { reference: true } },
    availability: { status: "available" },
  }));
}

function clientWith(respond: (args: Record<string, unknown>) => unknown) {
  const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
  const calls: Call[] = [];
  const transport = {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return respond(args);
    },
  };
  (client as unknown as { transport: typeof transport }).transport = transport;
  return { client, calls };
}

describe("discovering a catalogue the server pages", () => {
  it("keeps asking until the catalogue runs out", async () => {
    const all = catalogue(217);
    const { client, calls } = clientWith((args) => {
      const offset = Number(args.offset ?? 0);
      const limit = Math.min(Number(args.limit ?? SERVER_PAGE_CAP), SERVER_PAGE_CAP);
      return all.slice(offset, offset + limit);
    });

    const models = await client.listModels();

    expect(models).toHaveLength(217);
    expect(calls).toHaveLength(22);
    expect(calls[0]!.args).toMatchObject({ limit: SERVER_PAGE_CAP, offset: 0 });
    expect(calls[1]!.args).toMatchObject({ offset: SERVER_PAGE_CAP });
    // Availability is what the pickers filter on, so it has to survive paging.
    expect(models.every((m) => m.metadata.availability === "available")).toBe(true);
  });

  it("asks once when the server sends the whole catalogue anyway", async () => {
    const all = catalogue(217);
    const { client, calls } = clientWith(() => all);

    const models = await client.listModels();

    expect(models).toHaveLength(217);
    expect(calls).toHaveLength(1);
  });

  /** A server that honours `limit` but ignores `offset` would page for ever. */
  it("stops when a page repeats what it already has", async () => {
    const all = catalogue(217);
    const { client, calls } = clientWith(() => all.slice(0, SERVER_PAGE_CAP));

    const models = await client.listModels();

    expect(models).toHaveLength(SERVER_PAGE_CAP);
    expect(calls).toHaveLength(2);
  });

  it("falls back to one plain call when the server rejects the paging arguments", async () => {
    const all = catalogue(217);
    const { client, calls } = clientWith((args) => {
      if ("limit" in args) throw new Error("unexpected keyword argument 'limit'");
      return all;
    });

    const models = await client.listModels();

    expect(models).toHaveLength(217);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual({ include_availability: true });
  });

  /**
   * The exact shape that broke it: the first ten model types are music models,
   * so filtering by output afterwards left nothing to render with.
   */
  it("reaches the image and video models sitting past the first page", async () => {
    const all = [
      ...Array.from({ length: 9 }, (_, i) => ({
        model_type: `ace_step_${i}`,
        main_output: ["audio"],
        availability: { status: "available" },
        media_inputs: { audio: { output: true } },
      })),
      ...catalogue(12).map((m) => ({ ...m, model_type: `img_${m.model_type}` })),
    ];
    const { client } = clientWith((args) => {
      const offset = Number(args.offset ?? 0);
      return all.slice(offset, offset + SERVER_PAGE_CAP);
    });

    expect(await client.listModels("image")).toHaveLength(12);
  });
});
