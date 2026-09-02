import { describe, it, expect } from "vitest";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * WanGP made server filesystem paths opt-in.
 *
 * Every keyframe StoryForgeAI renders hands it a path — a character
 * photograph, or the frame carried over from the previous scene — so a server
 * started without `--mcp-allow-read-file-system` refuses every job in a batch.
 * The server's own wording asks for a "Gallery id", which names a WanGP
 * concept the operator cannot act on from this app.
 */

const REFUSAL =
  "Error executing tool wangp_generate: Direct filesystem paths are disabled for this " +
  "MCP server. Use a Gallery id for image_refs, or restart with filesystem reads enabled.";

function transportReturning(result: unknown) {
  const transport = new WangpMcpTransport("http://127.0.0.1:1/mcp");
  (transport as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
    callTool: async () => result,
    listTools: async () => ({ tools: [{ name: "wangp_list_models" }] }),
    getServerVersion: () => undefined,
    close: async () => undefined,
  });
  return transport;
}

describe("a WanGP server that refuses filesystem paths", () => {
  it("says which flag to restart with instead of asking for a Gallery id", async () => {
    const transport = transportReturning({
      isError: true,
      content: [{ type: "text", text: REFUSAL }],
    });

    await expect(transport.call("wangp_generate")).rejects.toThrow(
      /--mcp-allow-read-file-system/,
    );
  });

  it("keeps the server's own wording so the cause is still searchable", async () => {
    const transport = transportReturning({
      isError: true,
      content: [{ type: "text", text: REFUSAL }],
    });

    await expect(transport.call("wangp_generate")).rejects.toThrow(/Direct filesystem paths/);
  });

  it("leaves every other tool failure worded as it was", async () => {
    const transport = transportReturning({
      isError: true,
      content: [{ type: "text", text: "Unknown model_type: nope" }],
    });

    await expect(transport.call("wangp_generate")).rejects.toThrow(
      "WanGP tool wangp_generate failed: Unknown model_type: nope",
    );
  });
});

/**
 * `wangp_list_files` proves that filesystem reads are enabled when advertised.
 * Its absence is not proof of refusal: newer servers can accept generation
 * paths without exposing the file-browser tool.
 */
describe("detecting the setting before a batch is started", () => {
  const clientAdvertising = (names: string[]) => {
    const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
    const transport = {
      findTool: async (candidates: string[]) => candidates.find((c) => names.includes(c)),
    };
    (client as unknown as { transport: typeof transport }).transport = transport;
    return client;
  };

  it("leaves path support unknown when the filesystem tools are absent", async () => {
    expect(await clientAdvertising(["wangp_list_models"]).allowsFilesystemPaths()).toBeUndefined();
  });

  it("reports paths accepted when they are advertised", async () => {
    expect(
      await clientAdvertising(["wangp_list_models", "wangp_list_files"]).allowsFilesystemPaths(),
    ).toBe(true);
  });
});
