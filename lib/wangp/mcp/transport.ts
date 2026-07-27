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

  async ping(): Promise<{ connected: boolean; version?: string }> {
    const client = await this.connect();
    return { connected: true, version: client.getServerVersion()?.version };
  }

  async call(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_TOOLS.has(toolName)) throw new Error(`WanGP tool ${toolName} is not allowed.`);
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
