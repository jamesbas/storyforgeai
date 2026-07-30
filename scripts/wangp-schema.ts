import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * Dump one model's full default settings.
 *
 * `buildSettingsManifest` only overrides fields it knows about, so anything
 * WanGP defaults to travels into every job unexamined. This is how you find
 * out what those are.
 *
 *   npx tsx scripts/wangp-schema.ts flux2_klein_base_9b
 */
const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

async function main() {
  const modelType = process.argv[2];
  if (!modelType) throw new Error("usage: wangp-schema.ts <model_type> [field-filter-regex]");
  const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : undefined;

  const client = new LiveWangpClient(url);
  const schema = await client.getModelSchema(modelType);

  console.log(`\n=== ${modelType} ===`);
  console.log(`declared fields: ${schema.fields.map((f) => f.name).join(", ")}\n`);

  // Constraints decide what a manifest may legally write, so they matter as
  // much as the defaults.
  const constrained = schema.fields.filter((f) => f.allowed?.length);
  if (constrained.length) {
    console.log("allowed values:");
    for (const field of constrained) {
      console.log(`  ${field.name.padEnd(24)} ${field.allowed!.join(", ")}`);
    }
    console.log("");
  }

  console.log("default settings:");
  for (const [key, value] of Object.entries(schema.defaultSettings)) {
    if (filter && !filter.test(key)) continue;
    const rendered = JSON.stringify(value);
    console.log(`  ${key.padEnd(32)} ${rendered.length > 90 ? `${rendered.slice(0, 90)}…` : rendered}`);
  }
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
