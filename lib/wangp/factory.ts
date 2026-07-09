import type { WangpClient } from "@/lib/wangp/client";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { config } from "@/lib/config";

/**
 * Returns the process-wide WanGP client. Demo/local mode uses the mock client;
 * when WANGP_MCP_ENABLED is set a live MCP client would be returned. The live
 * client is not bundled in the MVP, so we fall back to the mock and mark the
 * mode, keeping the app runnable offline.
 */
const globalRef = globalThis as unknown as { __storyforgeWangp?: WangpClient };

export function getWangpClient(): WangpClient {
  if (globalRef.__storyforgeWangp) return globalRef.__storyforgeWangp;
  // A live client (WANGP_MCP_ENABLED) would be constructed here against
  // config.wangp.url. The MVP ships the mock; live wiring is flag-gated and
  // added in the WanGP integration pass (spec Section 23).
  const client = new MockWangpClient();
  globalRef.__storyforgeWangp = client;
  return client;
}

export function wangpEnabled(): boolean {
  return config.flags.wangpMcp;
}
