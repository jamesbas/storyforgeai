import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";

/**
 * Raw `wangp_list_models` output, exactly as the server sends it.
 *
 * Read-only. Exists because discovery breaks silently when WanGP changes the
 * shape or the paging of this call: `normalizeModel` drops what it cannot read
 * and the app just shows an empty picker.
 *
 * Usage: npx tsx scripts/wangp-list-raw.ts [limit] [offset] [query]
 */
const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

async function main() {
  const transport = new WangpMcpTransport(url);
  const limit = Number(process.argv[2] ?? 10);
  const offset = Number(process.argv[3] ?? 0);
  const query = process.argv[4];

  const found = await transport.findTool([
    "wangp_list_models",
    "wangp_search_models",
    "wangp_list_model_defs",
    "wangp_list_model_availability",
  ]);
  console.log(`first advertised discovery tool: ${found}\n`);

  const raw = await transport.call("wangp_list_models", {
    include_availability: true,
    limit,
    offset,
    ...(query ? { query } : {}),
  });
  const entries = Array.isArray(raw) ? raw : [raw];
  console.log(`returned ${entries.length} for limit=${limit} offset=${offset}${query ? ` query=${query}` : ""}\n`);
  console.log(`FIRST RECORD:\n${JSON.stringify(entries[0], null, 2)}\n`);
  console.log(
    `model_type :: name :: refs :: availability\n${entries
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        const image = ((r.media_inputs as Record<string, unknown>)?.image ?? {}) as Record<string, unknown>;
        const availability = (r.availability ?? {}) as Record<string, unknown>;
        return `  ${String(r.model_type)} :: ${String(r.name)} :: refs=${image.reference === true} :: ${String(availability.status)}`;
      })
      .join("\n")}`,
  );
}

void main()
  .catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e))
  .finally(() => process.exit(0));
