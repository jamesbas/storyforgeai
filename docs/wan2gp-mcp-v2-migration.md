# Wan2GP MCP v2 migration

StoryForgeAI supports both the historical WanGP MCP v1 contract and the consolidated MCP v2 contract served by default in Wan2GP 13.01. The client selects the contract from the advertised tool names; no WanGP compatibility flag is required.

## Impact assessment

| WanGP change | StoryForgeAI impact | Resolution |
| --- | --- | --- |
| Granular discovery tools replaced by `wangp_models` and `wangp_model` | Critical: the model lists and per-model generation controls could not load. | Detect `wangp_models`, use cursor-based `search`, and assemble schemas from `capabilities`, `definition`, and `defaults`. Keep the v1 calls as a fallback. |
| Model `capabilities` and media roles changed from boolean maps to string arrays | High: reference, start/end-frame, audio, and LoRA support would be read as false. | Normalize both boolean-map and string-array forms into the existing `WangpModel` shape. |
| Cursor pagination replaced offsets | High: one page would expose only part of the catalog. | Follow `has_more` and `next_cursor` with the original filters, de-duplicate model types, and retain the existing v1 offset walker. |
| MCP no longer reports checkpoint availability | High: the installed-only API filter would return no models. | Treat an omitted state as unknown and usable; exclude only models explicitly reported as `missing`. Settings explains that a v2 selection may download weights before rendering. |
| Generation moved behind the `generate` action and defaults to synchronous execution | Critical: the old `wait=false` call is rejected, while an unbounded `wait=true` exceeds the MCP SDK's one-minute request deadline. Wan2GP keeps rendering, but StoryForge loses the result. | Read the action contract once. Use `wait=false` when async is enabled; otherwise use `wait=true` with `timeout_s: 30`, receive the unfinished job ID, and poll it through `wangp_session`. |
| Job lookup and cancellation moved to `wangp_session` | Critical for async jobs and synchronous jobs returned after the bounded initial wait. | Route `get_job` and `cancel_job` through session actions on v2. Cancellation remains non-retryable. |
| Compact capabilities no longer contain full setting declarations | Critical: settings could be silently omitted from manifests. | Merge the full `definition` with pristine `defaults`; use compact capabilities only for metadata and input roles. |
| LoRA listing moved to `wangp_model / loras` | No product regression: StoryForgeAI already reads the configured local LoRA folders to include sidecar metadata and trigger words. | Keep the filesystem catalog. The v2 tool can be adopted later for remote installations. |
| Streamable HTTP, `/mcp`, generation settings, and filesystem permission rules remain stable | No migration required. | Existing transport, settings builder, and `--mcp-allow-read-file-system` guidance remain in effect. |

## Implementation plan and status

1. Detect v1 versus v2 from the advertised model-discovery tool. Completed.
2. Add v2 cursor discovery and normalize flat capability/media-role records. Completed.
3. Build the existing internal model schema from v2 capabilities, definition, and defaults. Completed.
4. Negotiate synchronous versus asynchronous generation and route v2 session operations. Completed.
5. Preserve usable model lists when availability is unknown and explain the limitation in Settings. Completed.
6. Keep v1 behavior and transport replay safeguards covered by regression tests. Completed.
7. Update WanGP diagnostics and integration documentation to negotiate either contract. Completed.
8. Recover rejected contract probes and dead tool-list sessions without restarting StoryForgeAI. Completed in 2.48.
9. Bound synchronous generation below the MCP SDK deadline and continue through session polling. Completed in 2.49.
10. Pass request options as the installed SDK's third `callTool` argument, after its optional result-schema slot. Completed in 2.50.

## Operational behavior

For immediate progress, cancellation, and restart reconciliation, WanGP can be launched with asynchronous MCP enabled:

```bash
python wgp.py --mcp --mcp-async
```

Without that flag, StoryForgeAI uses v2's supported synchronous call with a 30-second server wait. A quick job returns complete; a longer job returns its ID without being cancelled and StoryForgeAI polls it to completion. Progress and cancellation therefore begin after the initial wait rather than immediately.

MCP v1 remains available if an operator needs it:

```bash
python wgp.py --mcp --mcp-api-version 1
```

StoryForgeAI does not require either override.

> Applies to: StoryForgeAI's WanGP MCP integration against Wan2GP 13.01 and compatible v1 servers.
