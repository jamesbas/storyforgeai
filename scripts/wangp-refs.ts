import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { asRecord, knownKeys } from "@/lib/wangp/mcp/normalize";
import { resolveFieldMap } from "@/lib/wangp/mcp/aliases";

/**
 * Probe reference-image support for IMAGE generation.
 *
 * StoryForgeAI is discovery-first: WanGP publishes ~200 models whose settings
 * keys drift between versions, so the only trustworthy answer about what a
 * field is called and what shape it takes comes from the installed server. This
 * script answers the three questions that block wiring character reference
 * images into start/end frame generation:
 *
 *   1. Which installed image models advertise `media_inputs.image.reference`?
 *   2. What does the reference field look like — name, type, single vs list?
 *   3. Is it gated behind a prompt-type flag (`image_prompt_type` /
 *      `video_prompt_type`), the way start/end frames are gated behind "S"/"E"?
 *
 * Usage:
 *   npm run wangp:refs              # survey every ref-capable image model
 *   npm run wangp:refs qwen_image   # deep-dive one model type
 *   npm run wangp:refs qwen_image --raw   # untruncated prompt-type definitions
 */

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

/** Dump full JSON instead of truncated previews. */
const RAW = process.argv.includes("--raw");

/** Keys worth dumping verbatim when hunting for the reference-image control. */
const INTERESTING = /ref|image|prompt_type|guide|mask|identity|face|ip_?adapter|lora/i;

function preview(value: unknown, max = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";  if (RAW) return typeof value === "string" ? text : JSON.stringify(value, null, 2);  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function mediaInputs(source: Record<string, unknown> | undefined) {
  const direct = asRecord(source?.media_inputs) ?? asRecord(source?.mediaInputs);
  if (direct) return direct;
  const def = asRecord(source?.model) ?? asRecord(source?.model_def) ?? {};
  return asRecord(def.media_inputs) ?? {};
}

function modelTypeOf(entry: unknown): string | undefined {
  const record = asRecord(entry);
  const value = record?.model_type ?? record?.modelType;
  return typeof value === "string" ? value : undefined;
}

async function surveyCatalog(transport: WangpMcpTransport) {
  const raw = await transport.call("wangp_list_models", { include_availability: true });
  const entries = Array.isArray(raw) ? raw : [];
  console.log(`catalog: ${entries.length} models\n`);

  const refCapable: string[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    const modelType = modelTypeOf(entry);
    if (!modelType) continue;

    // Discovery payloads often omit media_inputs; fall back to a metadata call.
    let image = asRecord(mediaInputs(record).image);
    if (!image) {
      const metadata = await transport
        .call("wangp_get_model_metadata", { model_type: modelType })
        .then(asRecord)
        .catch(() => undefined);
      image = asRecord(mediaInputs(metadata).image);
    }
    if (image?.reference !== true) continue;

    const outputs = record?.main_output ?? record?.mainOutput;
    const availability = record?.availability ?? record?.available;
    refCapable.push(modelType);
    console.log(
      `  ${modelType.padEnd(34)} out=${preview(outputs, 24).padEnd(24)} ` +
        `avail=${preview(availability, 12).padEnd(12)} refs=yes`,
    );
  }

  console.log(`\nreference-capable models: ${refCapable.length}`);
  return refCapable;
}

async function inspectModel(transport: WangpMcpTransport, modelType: string) {
  console.log(`\n${"=".repeat(72)}\n=== ${modelType}\n${"=".repeat(72)}`);

  const [rawSchema, rawDefaults, rawMetadata] = await Promise.all([
    transport.call("wangp_get_model_schema", { model_type: modelType }).then(asRecord),
    transport.call("wangp_get_default_settings", { model_type: modelType }).then(asRecord),
    transport
      .call("wangp_get_model_metadata", { model_type: modelType })
      .then(asRecord)
      .catch(() => undefined),
  ]);

  const schema = rawSchema ?? {};
  const defaults = rawDefaults ?? {};

  if (process.argv.includes("--dump")) {
    console.log("\n--- FULL RAW SCHEMA ---");
    console.log(JSON.stringify(schema, null, 2));
    console.log("\n--- FULL RAW DEFAULTS ---");
    console.log(JSON.stringify(defaults, null, 2));
    return;
  }

  console.log("\n--- media_inputs (capability flags) ---");
  console.log(preview(mediaInputs(rawMetadata) ?? mediaInputs(schema), 800));

  // What StoryForgeAI's own normalization concludes. If image_refs is absent
  // here, buildSettingsManifest would silently drop the value.
  const merged = { ...schema };
  if (rawMetadata && merged.metadata === undefined) merged.metadata = rawMetadata;
  const keys = knownKeys(merged, defaults);
  const fieldMap = resolveFieldMap(keys);
  console.log("\n--- StoryForgeAI canonical field map ---");
  console.log(`  image_start : ${fieldMap.image_start ?? "(unsupported)"}`);
  console.log(`  image_end   : ${fieldMap.image_end ?? "(unsupported)"}`);
  console.log(`  image_refs  : ${fieldMap.image_refs ?? "(unsupported)"}`);
  console.log(`  image_guide : ${fieldMap.image_guide ?? "(unsupported)"}`);
  console.log(`  prompt_type : ${fieldMap.image_prompt_type ?? "(unsupported)"}`);

  console.log("\n--- default values for interesting keys (reveals expected SHAPE) ---");
  const defaultHits = Object.entries(defaults).filter(([key]) => INTERESTING.test(key));
  if (!defaultHits.length) console.log("  (none)");
  for (const [key, value] of defaultHits) {
    const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    console.log(`  ${key.padEnd(24)} ${kind.padEnd(8)} = ${preview(value)}`);
  }

  console.log("\n--- raw schema definitions for interesting keys ---");
  const containers = ["properties", "settings", "setting_values"] as const;
  let printed = 0;
  for (const name of containers) {
    const container = asRecord(schema[name]);
    if (!container) continue;
    for (const [key, definition] of Object.entries(container)) {
      if (!INTERESTING.test(key)) continue;
      console.log(`  [${name}] ${key}: ${preview(definition, 400)}`);
      printed += 1;
    }
  }
  if (Array.isArray(schema.fields)) {
    for (const field of schema.fields) {
      const item = asRecord(field);
      const name = item?.name ?? item?.key ?? item?.id;
      if (typeof name !== "string" || !INTERESTING.test(name)) continue;
      console.log(`  [fields] ${name}: ${preview(item, 400)}`);
      printed += 1;
    }
  }
  if (!printed) console.log("  (no per-key definitions published)");

  // Start/end frames are activated by letters in image_prompt_type ("S", "SE").
  // If references need their own letter, it will show up in the allowed values.
  console.log("\n--- prompt-type gating (does a flag activate the refs?) ---");
  for (const key of ["image_prompt_type", "video_prompt_type"]) {
    const definition = containers
      .map((name) => asRecord(schema[name])?.[key])
      .find((value) => value !== undefined);
    console.log(`  ${key}: default=${preview(defaults[key], 60)} def=${preview(definition, 400)}`);
  }
}

/**
 * Dump the MCP tool declaration for `wangp_generate`.
 *
 * `image_refs` is inferred from a capability flag rather than published in
 * default settings, so it has no default value to reveal its shape. The tool's
 * own input schema is the only authoritative description of what the `source`
 * payload accepts.
 */
async function inspectGenerateTool(transport: WangpMcpTransport) {
  const client = (await transport.connect()) as unknown as {
    listTools(): Promise<{ tools: Record<string, unknown>[] }>;
  };
  const { tools } = await client.listTools();
  console.log(`\n--- MCP tools advertised: ${tools.length} ---`);
  console.log(tools.map((t) => String(t.name)).join(", "));

  for (const tool of tools) {
    if (!/generate|upload|file|image/i.test(String(tool.name))) continue;
    console.log(`\n=== tool: ${String(tool.name)} ===`);
    console.log(`description: ${preview(tool.description, 1200)}`);
    console.log(`inputSchema: ${preview(tool.inputSchema, 4000)}`);
  }
}

async function main() {
  const transport = new WangpMcpTransport(url);
  console.log(`probing ${url}\n`);

  try {
    if (process.argv.includes("--tools")) {
      await inspectGenerateTool(transport);
      return;
    }

    const target = process.argv[2];
    if (target && !target.startsWith("--")) {
      await inspectModel(transport, target);
      return;
    }

    const refCapable = await surveyCatalog(transport);
    // Deep-dive a couple so the shape is visible without a second invocation.
    for (const modelType of refCapable.slice(0, 3)) {
      await inspectModel(transport, modelType);
    }
    if (!refCapable.length) {
      console.log(
        "\nNo installed model advertises image reference input. " +
          "Reference-image conditioning is not available on this WanGP install.",
      );
    }
  } finally {
    await transport.close();
  }
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
