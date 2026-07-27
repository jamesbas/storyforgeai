import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { normalizeJob } from "@/lib/wangp/mcp/normalize";

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

/** Inspect or cancel a WanGP job: npx tsx scripts/wangp-job.ts <jobId> [--cancel] */
async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("usage: wangp-job.ts <jobId> [--cancel]");
  const t = new WangpMcpTransport(url);

  if (process.argv.includes("--cancel")) {
    console.log(JSON.stringify(await t.call("wangp_cancel_job", { job_id: jobId })));
  }
  const raw = await t.call("wangp_get_job", { job_id: jobId });
  console.log("normalized:", JSON.stringify(normalizeJob(raw, jobId)));
  await t.close();
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
