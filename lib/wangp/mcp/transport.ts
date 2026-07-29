import { z } from "zod";
import { asRecord } from "@/lib/wangp/mcp/normalize";

/**
 * Minimal MCP transport wrapper for a WanGP server.
 *
 * Ported from easynediacreator `lib/wan-gp/live-client.ts`. Responsibilities:
 * lazy single-flight connect, a hard allow-list of callable tools, and
 * unwrapping WanGP's structured-vs-text tool results into plain JSON.
 *
 * The allow-list is the security boundary: no caller can reach an arbitrary
 * tool on the MCP server even if a tool name flows in from data.
 */

export const ALLOWED_TOOLS = new Set([
  "wangp_list_models",
  "wangp_get_model_metadata",
  "wangp_get_model_availability",
  "wangp_get_default_settings",
  "wangp_get_model_schema",
  "wangp_generate",
  "wangp_get_job",
  "wangp_cancel_job",
  "wangp_list_lora_presets",
  "wangp_list_loras",
  "wangp_get_loras",
]);

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
});

/** WanGP wraps single-value results in `{ result: ... }`; unwrap it. */
export function unwrapStructuredContent(value: unknown): unknown {
  const source = asRecord(value);
  if (source && Object.keys(source).length === 1 && "result" in source) return source.result;
  return value;
}

export function parseTextContent(content: { type: string; text?: string }[]): unknown {
  const texts = content
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text as string);
  if (!texts.length) throw new Error("WanGP tool returned no structured data.");
  try {
    const values = texts.map((text) => JSON.parse(text));
    return values.length === 1 ? values[0] : values;
  } catch {
    throw new Error("WanGP tool returned invalid JSON.");
  }
}

type McpClient = {
  connect(transport: unknown): Promise<void>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  getServerVersion(): { version?: string } | undefined;
  close(): Promise<void>;
};

/**
 * Tools that can safely be called twice.
 *
 * A reconnect retry replays the request, so anything that starts work must not
 * be on this list: a `wangp_generate` whose response was lost has still queued
 * a generation, and replaying it would submit a second one.
 */
const IDEMPOTENT_TOOLS = new Set([
  "wangp_list_models",
  "wangp_get_model_metadata",
  "wangp_get_model_availability",
  "wangp_get_default_settings",
  "wangp_get_model_schema",
  "wangp_get_job",
  "wangp_list_lora_presets",
  "wangp_list_loras",
  "wangp_get_loras",
]);

/**
 * A failure of the connection itself rather than of the tool.
 *
 * `fetch failed` is what undici reports for a dropped socket, and it is the
 * shape a long batch actually hits: the MCP session outlives an hour of
 * generation and then goes away underneath us.
 */
function isTransportFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|econnreset|econnrefused|etimedout|epipe|socket hang up|network|terminated|not connected|closed/i.test(
    message,
  );
}

export class WangpMcpTransport {
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private toolNames?: Set<string>;

  constructor(private readonly endpoint: string) {}

  async connect(): Promise<McpClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        // Dynamic import keeps the SDK (and its ESM-only deps) out of the
        // bundle when the live client is flag-disabled.
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const client = new Client({ name: "storyforgeai", version: "0.1.0" }) as unknown as McpClient;
        await client.connect(new StreamableHTTPClientTransport(new URL(this.endpoint)));
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /**
   * Throw away the cached client so the next call dials again.
   *
   * Without this a single dropped socket is permanent: every later call reuses
   * the dead client and fails with the same `fetch failed`, which is how one
   * network blip ended a batch that still had four hours of work queued.
   */
  private discard(): void {
    const dead = this.client;
    this.client = undefined;
    this.toolNames = undefined;
    void dead?.close().catch(() => undefined);
  }

  async ping(): Promise<{ connected: boolean; version?: string }> {
    try {
      const client = await this.connect();
      return { connected: true, version: client.getServerVersion()?.version };
    } catch (err) {
      if (isTransportFailure(err)) this.discard();
      throw err;
    }
  }

  async call(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_TOOLS.has(toolName)) throw new Error(`WanGP tool ${toolName} is not allowed.`);
    try {
      return await this.invoke(toolName, args);
    } catch (err) {
      if (!isTransportFailure(err)) throw err;
      this.discard();
      // Reconnecting costs one round trip and rescues the common case, but only
      // where replaying the request cannot start a second generation.
      if (!IDEMPOTENT_TOOLS.has(toolName)) throw err;
      return this.invoke(toolName, args);
    }
  }

  private async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connect();
    const result = toolResultSchema.parse(await client.callTool({ name: toolName, arguments: args }));

    if (result.isError) {
      const details = result.content
        .filter((item) => item.type === "text" && item.text)
        .map((item) => item.text)
        .join(" ");
      throw new Error(`WanGP tool ${toolName} failed${details ? `: ${details}` : "."}`);
    }

    if (result.structuredContent !== undefined) {
      return unwrapStructuredContent(result.structuredContent);
    }
    return parseTextContent(result.content);
  }

  /** Resolve the first advertised tool name from a candidate list, or undefined. */
  async findTool(candidates: string[]): Promise<string | undefined> {
    if (!this.toolNames) {
      const client = await this.connect();
      this.toolNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
    }
    return candidates.find((candidate) => this.toolNames?.has(candidate));
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.toolNames = undefined;
  }
}
