import { LiveWangpClient } from "@/lib/wangp/live-client";

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

async function main() {
  const client = new LiveWangpClient(url);
  const all = await client.listModels();
  const pattern = new RegExp(process.argv[2] ?? "ltx|qwen|flux", "i");

  for (const kind of ["image", "video"] as const) {
    console.log(`\n=== ${kind} models matching /${pattern.source}/ ===`);
    for (const m of all.filter((x) => (x.metadata.outputs ?? [x.metadata.mainOutput]).includes(kind))) {
      if (!pattern.test(m.modelType) && !pattern.test(m.name)) continue;
      const img = m.metadata.mediaInputs?.image;
      const flags = [
        img?.start ? "start" : "",
        img?.end ? "end" : "",
        img?.reference ? "ref" : "",
        m.metadata.mediaInputs?.audio?.output ? "audio-out" : "",
      ].filter(Boolean);
      console.log(`  ${m.modelType.padEnd(30)} ${flags.join(",").padEnd(26)} ${m.name}`);
    }
  }
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
