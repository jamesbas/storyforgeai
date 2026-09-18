import { LiveWangpClient } from "@/lib/wangp/live-client";

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

/** Report server-provided installation state; MCP v2 records it as unknown. */
async function main() {
  const client = new LiveWangpClient(url);
  const models = await client.listModels();

  const counts: Record<string, number> = {};
  for (const model of models) {
    const a = model.metadata.availability ?? "unknown";
    counts[a] = (counts[a] ?? 0) + 1;
  }
  console.log("availability across catalog:", JSON.stringify(counts));
  if (counts.unknown) {
    console.log("MCP v2 does not expose local checkpoint availability; unknown is not the same as missing.");
  }

  const pattern = new RegExp(process.argv[2] ?? ".", "i");
  console.log(`\navailable models matching /${pattern.source}/:`);
  for (const model of models) {
    if (model.metadata.availability === "missing") continue;
    if (!pattern.test(model.modelType) && !pattern.test(model.name)) continue;
    const outs = JSON.stringify(model.metadata.outputs ?? [model.metadata.mainOutput]);
    console.log(`  ${model.modelType.padEnd(34)} ${outs.padEnd(22)} ${model.name}`);
  }
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
