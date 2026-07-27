import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

function statusOf(m: Record<string, unknown>): string {
  const a = m.availability;
  if (a && typeof a === "object" && "status" in a) return String((a as { status: unknown }).status);
  return String(a ?? "unknown");
}

/** Which models are actually installed locally, so we never pin a 20GB download. */
async function main() {
  const t = new WangpMcpTransport(url);
  const raw = (await t.call("wangp_list_models", { include_availability: true })) as Record<
    string,
    unknown
  >[];

  const counts: Record<string, number> = {};
  for (const m of raw) {
    const a = statusOf(m);
    counts[a] = (counts[a] ?? 0) + 1;
  }
  console.log("availability across catalog:", JSON.stringify(counts));

  const pattern = new RegExp(process.argv[2] ?? ".", "i");
  console.log(`\navailable models matching /${pattern.source}/:`);
  for (const m of raw) {
    if (statusOf(m) !== "available") continue;
    const type = String(m.model_type ?? "");
    if (!pattern.test(type) && !pattern.test(String(m.name ?? ""))) continue;
    const outs = JSON.stringify(m.main_output);
    console.log(`  ${type.padEnd(34)} ${outs.padEnd(22)} ${m.name}`);
  }
  await t.close();
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
