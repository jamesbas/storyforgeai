import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";

/**
 * Raw model-search output, exactly as the server sends it.
 *
 * Read-only. Exists because discovery breaks silently when WanGP changes the
 * shape or the paging of this call: `normalizeModel` drops what it cannot read
 * and the app just shows an empty picker.
 *
 * Usage: npx tsx scripts/wangp-list-raw.ts [limit] [cursor-or-offset] [query]
 */
const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";

async function main() {
  const transport = new WangpMcpTransport(url);
  const limit = Number(process.argv[2] ?? 10);
  const position = process.argv[3];
  const query = process.argv[4];

  const found = await transport.findTool([
    "wangp_models",
    "wangp_list_models",
    "wangp_search_models",
    "wangp_list_model_defs",
    "wangp_list_model_availability",
  ]);
  console.log(`first advertised discovery tool: ${found}\n`);

  const v2 = found === "wangp_models";
  const raw = v2
    ? await transport.call("wangp_models", {
        action: "search",
        arguments: {
          limit,
          ...(position ? { cursor: position } : {}),
          ...(query ? { query } : {}),
        },
      })
    : await transport.call("wangp_list_models", {
        include_availability: true,
        limit,
        offset: Number(position ?? 0),
        ...(query ? { query } : {}),
      });
  const result = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const entries = Array.isArray(raw)
    ? raw
    : ([result.models, result.results, result.items, result.entries].find(Array.isArray) ?? []);
  console.log(`returned ${entries.length} for limit=${limit}${position ? ` position=${position}` : ""}${query ? ` query=${query}` : ""}\n`);
  if (v2) {
    console.log(`has_more=${String(result.has_more)} next_cursor=${String(result.next_cursor ?? "")}\n`);
  }
  console.log(`FIRST RECORD:\n${JSON.stringify(entries[0], null, 2)}\n`);
  console.log(
    `model_type :: name :: refs :: availability\n${entries
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        const image = ((r.media_inputs as Record<string, unknown>)?.image ?? {}) as
          | Record<string, unknown>
          | unknown[];
        const availability = (r.availability ?? {}) as Record<string, unknown>;
        const refs = Array.isArray(image) ? image.includes("reference") : image.reference === true;
        return `  ${String(r.model_type)} :: ${String(r.name)} :: refs=${refs} :: ${String(availability.status ?? "unknown")}`;
      })
      .join("\n")}`,
  );
}

void main()
  .catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e))
  .finally(() => process.exit(0));
