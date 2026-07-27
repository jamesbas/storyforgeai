import { LiveWangpClient } from "@/lib/wangp/live-client";
import { normalizeModelSchema } from "@/lib/wangp/mcp/normalize";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { asRecord } from "@/lib/wangp/mcp/normalize";

/**
 * Live MCP probe. Read-only: discovery + schema only, no generation.
 * Usage: npx tsx scripts/wangp-probe.ts [modelType]
 */
const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

async function main() {
  const client = new LiveWangpClient(url);

  console.log(`connecting to ${url}`);
  console.log(`health: ${await client.health()}`);

  const all = await client.listModels();
  const byOutput = all.reduce<Record<string, number>>((acc, m) => {
    acc[m.metadata.mainOutput] = (acc[m.metadata.mainOutput] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`models discovered: ${all.length}`, JSON.stringify(byOutput));

  const withAudio = all.filter((m) => m.metadata.mediaInputs?.audio?.output);
  console.log(`models emitting audio: ${withAudio.length}`);
  console.log(
    `  sample: ${withAudio.slice(0, 6).map((m) => m.modelType).join(", ")}`,
  );

  const startEnd = all.filter(
    (m) => m.metadata.mediaInputs?.image?.start && m.metadata.mediaInputs?.image?.end,
  );
  console.log(`video models with start+end keyframes: ${startEnd.length}`);
  console.log(`  sample: ${startEnd.slice(0, 6).map((m) => m.modelType).join(", ")}`);

  const target =
    process.argv[2] ??
    startEnd.find((m) => m.modelType.includes("ltx"))?.modelType ??
    startEnd[0]?.modelType;
  if (!target) {
    console.log("no start/end-capable video model found");
    return;
  }

  console.log(`\n=== schema for ${target} ===`);
  const schema = await client.getModelSchema(target);
  console.log(`canonical fields: ${schema.fields.map((f) => f.name).join(", ")}`);
  for (const f of schema.fields) {
    const bits = [
      f.type,
      f.allowed ? `allowed=${JSON.stringify(f.allowed).slice(0, 90)}` : "",
      f.min !== undefined ? `min=${f.min}` : "",
      f.max !== undefined ? `max=${f.max}` : "",
    ].filter(Boolean);
    console.log(`  ${f.name.padEnd(22)} ${bits.join(" ")}`);
  }
  console.log(
    `defaults (canonical subset): ${JSON.stringify(
      Object.fromEntries(
        schema.fields
          .map((f) => [f.name, schema.defaultSettings[f.name]])
          .filter(([, v]) => v !== undefined),
      ),
    ).slice(0, 600)}`,
  );

  // Raw alias mapping, to confirm what the real keys are called.
  const transport = new WangpMcpTransport(url);
  const rawSchema = asRecord(await transport.call("wangp_get_model_schema", { model_type: target })) ?? {};
  const rawDefaults = asRecord(await transport.call("wangp_get_default_settings", { model_type: target })) ?? {};
  const metadata = asRecord(await transport.call("wangp_get_model_metadata", { model_type: target }));
  if (metadata && rawSchema.metadata === undefined) rawSchema.metadata = metadata;
  const { fieldMap } = normalizeModelSchema(target, rawSchema, rawDefaults);
  console.log(`\ncanonical -> real WanGP key:`);
  for (const [k, v] of Object.entries(fieldMap)) console.log(`  ${k.padEnd(22)} -> ${v}`);
  console.log(`\nprompt_enhancer default: ${JSON.stringify(rawDefaults.prompt_enhancer)}`);
  await transport.close();
}

void main().catch((err) => {
  console.error("PROBE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
