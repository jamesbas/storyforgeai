import type { WangpClient } from "@/lib/wangp/client";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { LiveWangpClient } from "@/lib/wangp/live-client";
import { config } from "@/lib/config";

/**
 * Returns the process-wide WanGP client. Demo/local mode uses the mock client;
 * WANGP_MCP_ENABLED selects the live MCP client at config.wangp.url
 * (spec Section 23).
 */
const globalRef = globalThis as unknown as { __storyforgeWangp?: WangpClient };

export function getWangpClient(): WangpClient {
  if (globalRef.__storyforgeWangp) return globalRef.__storyforgeWangp;
  const client: WangpClient = config.flags.wangpMcp
    ? new LiveWangpClient(config.wangp.url)
    : new MockWangpClient();
  globalRef.__storyforgeWangp = client;
  return client;
}

/** Override the process-wide client (tests, or a swap after a config change). */
export function setWangpClient(client?: WangpClient): void {
  globalRef.__storyforgeWangp = client;
}

export function wangpEnabled(): boolean {
  return config.flags.wangpMcp;
}
