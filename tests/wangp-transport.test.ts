import { describe, it, expect } from "vitest";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";

/**
 * MCP transport resilience.
 *
 * The transport caches one connected client for the life of the process. When
 * the socket died — an hour into a batch, which is when it actually happens —
 * every later call reused the dead client and failed with the same
 * `fetch failed`, so the connection never came back and the run was over.
 */

type Call = { name: string; arguments: Record<string, unknown> };

/** Stand-in for the MCP SDK client, with scripted failures. */
function fakeClient(behaviour: { failCalls: number }) {
  const calls: Call[] = [];
  let remaining = behaviour.failCalls;
  return {
    calls,
    closed: 0,
    async connect() {},
    async callTool(request: Call) {
      calls.push(request);
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("fetch failed");
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
    async listTools() {
      return { tools: [] };
    },
    getServerVersion() {
      return { version: "1" };
    },
    async close() {
      this.closed += 1;
    },
  };
}

/**
 * Drive the transport against a fake client.
 *
 * `connect` is private, so the fake is installed by replacing it — the same
 * seam the real code uses to memoise a connection.
 */
function transportWith(clients: ReturnType<typeof fakeClient>[]) {
  const transport = new WangpMcpTransport("http://127.0.0.1:7866/mcp");
  let dialled = 0;
  const internals = transport as unknown as {
    client?: unknown;
    connect: () => Promise<unknown>;
  };
  internals.connect = async () => {
    if (!internals.client) {
      internals.client = clients[Math.min(dialled, clients.length - 1)];
      dialled += 1;
    }
    return internals.client;
  };
  return { transport, dialled: () => dialled };
}

describe("recovering a dropped connection", () => {
  it("reconnects and retries an idempotent call", async () => {
    const dead = fakeClient({ failCalls: 1 });
    const fresh = fakeClient({ failCalls: 0 });
    const { transport, dialled } = transportWith([dead, fresh]);

    const result = await transport.call("wangp_get_job", { job_id: "j1" });

    expect(result).toEqual({ ok: true });
    expect(dialled()).toBe(2);
    expect(fresh.calls).toHaveLength(1);
  });

  /**
   * A generate whose response was lost has still queued work on the GPU, so
   * replaying it would render the scene twice.
   */
  it("does not replay a generate, but still drops the dead client", async () => {
    const dead = fakeClient({ failCalls: 1 });
    const fresh = fakeClient({ failCalls: 0 });
    const { transport } = transportWith([dead, fresh]);

    await expect(transport.call("wangp_generate", { source: {} })).rejects.toThrow(/fetch failed/i);
    expect(fresh.calls).toHaveLength(0);

    // The next call gets a working connection rather than the dead one.
    await expect(transport.call("wangp_generate", { source: {} })).resolves.toEqual({ ok: true });
  });

  /** A tool that reports a real error must not be retried or hide the reason. */
  it("passes a tool-level failure straight through", async () => {
    const client = {
      ...fakeClient({ failCalls: 0 }),
      async callTool() {
        return { isError: true, content: [{ type: "text", text: "unknown model_type" }] };
      },
    } as unknown as ReturnType<typeof fakeClient>;
    const { transport, dialled } = transportWith([client]);

    await expect(transport.call("wangp_get_job", { job_id: "j1" })).rejects.toThrow(
      /unknown model_type/,
    );
    expect(dialled()).toBe(1);
  });
});
