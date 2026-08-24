import type { WangpClient } from "@/lib/wangp/client";
import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import { asRecord, normalizeJob, normalizeModel, normalizeModelSchema } from "@/lib/wangp/mcp/normalize";
import { toWangpSettings, type FieldMap } from "@/lib/wangp/mcp/aliases";
import { produces } from "@/lib/wangp/model-router";
import { logEvent } from "@/lib/telemetry";

/** How long a catalogue listing stays good. Matches the LoRA catalogue. */
const MODEL_CACHE_TTL_MS = 60_000;

/**
 * How many models one `wangp_list_models` call returns.
 *
 * WanGP clamps the argument with `max(1, min(limit, 10))` and defaults it to
 * ten, so asking for more is silently ignored. Ten is the whole page.
 */
const MODEL_PAGE_SIZE = 10;

/** A stop so a server that ignores `offset` cannot page for ever. */
const MAX_DISCOVERED_MODELS = 2_000;

/**
 * Live WanGP MCP client (spec Section 23).
 *
 * Implements the same `WangpClient` interface as `MockWangpClient`, so the
 * agent, service, and UI layers are unchanged. All WanGP field-name drift is
 * absorbed by `mcp/aliases.ts` + `mcp/normalize.ts`.
 */
export class LiveWangpClient implements WangpClient {
  readonly mode = "live" as const;

  private readonly transport: WangpMcpTransport;
  private readonly metadataCache = new Map<string, Record<string, unknown>>();
  private readonly schemaCache = new Map<string, { schema: WangpModelSchema; fieldMap: FieldMap }>();
  /**
   * The catalogue, cached briefly rather than for the life of the process.
   *
   * Availability is mutable state: it flips the moment WanGP finishes fetching
   * a model's weights. Cached permanently, a model downloaded while
   * StoryForgeAI was running stayed "not installed" in every picker until the
   * app was restarted — with WanGP itself reporting it available the whole
   * time. Sixty seconds matches the LoRA catalogue, which was given a TTL for
   * the same reason. The metadata and schema caches are left alone, so a
   * refresh costs one call rather than one per model.
   */
  private modelCache?: { at: number; models: WangpModel[] };

  /** The discovery walk in flight, so parallel callers share one. */
  private modelRefresh?: Promise<WangpModel[]>;

  constructor(endpoint: string) {
    this.transport = new WangpMcpTransport(endpoint);
  }

  async health(): Promise<boolean> {
    try {
      return (await this.transport.ping()).connected;
    } catch (err) {
      logEvent("wangp.health.failed", { message: err instanceof Error ? err.message : "unknown" });
      return false;
    }
  }

  /**
   * The catalogue, answered from cache the moment there is one.
   *
   * A cold walk is one MCP call per ten models — around fifteen for a WanGP
   * install of any size — so waiting for it stalled every visit to project
   * settings that fell outside the TTL. An expired copy is handed back and
   * refreshed behind the caller instead: the picker opens instantly, and a
   * model that finished downloading appears on the next read or on Refresh.
   */
  async listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]> {
    const cached = this.modelCache;
    if (!cached || Date.now() - cached.at >= MODEL_CACHE_TTL_MS) {
      const refresh = this.refreshModels();
      // Nothing to show on the first load, so that one waits. A failed
      // background walk leaves the stale copy standing and is retried by the
      // next caller.
      if (!cached) await refresh;
      else void refresh.catch(() => undefined);
    }

    const models = this.modelCache?.models ?? [];
    return mainOutput ? models.filter((m) => produces(m, mainOutput)) : models;
  }

  /** One walk at a time, however many callers are waiting on it. */
  private refreshModels(): Promise<WangpModel[]> {
    if (!this.modelRefresh) {
      this.modelRefresh = this.discoverModels()
        .then((models) => {
          this.modelCache = { at: Date.now(), models };
          return models;
        })
        .finally(() => {
          this.modelRefresh = undefined;
        });
    }
    return this.modelRefresh;
  }

  private async discoverModels(): Promise<WangpModel[]> {
    const { entries, pages } = await this.listModelEntries();

    const models: WangpModel[] = [];
    for (const entry of entries) {
      // Discovery payloads often omit media_inputs; enrich only when needed so
      // a large model catalog does not trigger a metadata call per model.
      const source = asRecord(entry);
      const modelType =
        typeof source?.model_type === "string"
          ? source.model_type
          : typeof source?.modelType === "string"
            ? source.modelType
            : undefined;
      const needsMetadata = Boolean(modelType) && !source?.media_inputs && !source?.mediaInputs;
      const metadata = needsMetadata ? await this.getMetadata(modelType!) : undefined;

      const model = normalizeModel(entry, metadata);
      if (model) models.push(model);
    }

    logEvent("wangp.discovery", { mode: "live", count: models.length, pages, listed: entries.length });
    return models;
  }

  /**
   * Every model the server has, gathered a page at a time.
   *
   * WanGP capped `wangp_list_models` at ten records per call and made ten the
   * default. One unpaged request therefore returns the first ten model types
   * alphabetically — nine music models and one video model — which is how a
   * 216-model catalogue turned into an empty picker with no error anywhere.
   */
  private async listModelEntries(): Promise<{ entries: unknown[]; pages: number }> {
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let pages = 0;

    /** New rows in this page. Zero means the server is repeating itself. */
    const collect = (raw: unknown): { added: number; size: number } => {
      const page = Array.isArray(raw) ? raw : [];
      let added = 0;
      for (const entry of page) {
        const source = asRecord(entry);
        const key = source?.model_type ?? source?.modelType;
        const id = typeof key === "string" && key ? key : undefined;
        // A row with no model type cannot be de-duplicated, and normalizeModel
        // will drop it anyway.
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        entries.push(entry);
        added += 1;
      }
      return { added, size: page.length };
    };

    for (let offset = 0; offset < MAX_DISCOVERED_MODELS; offset += MODEL_PAGE_SIZE) {
      let raw: unknown;
      try {
        raw = await this.transport.call("wangp_list_models", {
          include_availability: true,
          limit: MODEL_PAGE_SIZE,
          offset,
        });
      } catch (err) {
        // A server predating these arguments rejects them outright — and has no
        // cap, so one plain call is the entire catalogue.
        if (offset > 0) throw err;
        logEvent("wangp.discovery.unpaged", {
          reason: err instanceof Error ? err.message : "unknown",
        });
        collect(await this.transport.call("wangp_list_models", { include_availability: true }));
        return { entries, pages: 1 };
      }

      pages += 1;
      const { added, size } = collect(raw);
      // A short page is the end of the catalogue. A page longer than we asked
      // for, or one carrying nothing new, is a server ignoring the arguments —
      // in both cases there is nothing further to ask for.
      if (size < MODEL_PAGE_SIZE || size > MODEL_PAGE_SIZE || added === 0) break;
    }

    return { entries, pages };
  }


  /**
   * Drop the cached catalogue, for an explicit refresh.
   *
   * A walk already in flight is left alone — it started after the reset was
   * asked for in every case that matters, and its result is as fresh as one
   * begun now.
   */
  resetModelCache(): void {
    this.modelCache = undefined;
  }

  /**
   * Whether this server accepts a file path where a reference image is wanted.
   *
   * Read off the advertised tool list rather than by trying a render: WanGP
   * registers `wangp_list_files` only when it was started with filesystem
   * reads, so its presence is the same switch that decides whether a keyframe
   * job is accepted or refused.
   */
  async allowsFilesystemPaths(): Promise<boolean> {
    return (await this.transport.findTool(["wangp_list_files"])) !== undefined;
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    return (await this.resolveSchema(modelType)).schema;
  }

  async generate(settings: Record<string, unknown>): Promise<WangpJob> {
    const modelType = settings.model_type;
    if (typeof modelType !== "string" || !modelType) {
      throw new Error("WanGP generate requires a model_type in the settings manifest.");
    }

    const { fieldMap } = await this.resolveSchema(modelType);
    const canonical = this.applyImagePromptType({ ...settings }, fieldMap);
    const payload = toWangpSettings(canonical, fieldMap);
    payload.model_type = modelType;

    const raw = asRecord(
      await this.transport.call("wangp_generate", { source: payload, wait: false }),
    );
    const jobId = raw?.job_id ?? raw?.jobId ?? raw?.id;
    if (typeof jobId !== "string" || !jobId) {
      throw new Error("WanGP did not return a job id.");
    }

    return { id: jobId, status: "submitted", progress: 0, generatedFiles: [], errors: [] };
  }

  async getJob(jobId: string): Promise<WangpJob> {
    return normalizeJob(await this.transport.call("wangp_get_job", { job_id: jobId }), jobId);
  }

  async cancelJob(jobId: string): Promise<WangpJob> {
    await this.transport.call("wangp_cancel_job", { job_id: jobId });
    return this.getJob(jobId).catch(() => ({
      id: jobId,
      status: "cancelled" as const,
      progress: 0,
      generatedFiles: [],
      errors: [],
    }));
  }

  private async getMetadata(modelType: string): Promise<Record<string, unknown> | undefined> {
    const cached = this.metadataCache.get(modelType);
    if (cached) return cached;
    try {
      const metadata = asRecord(
        await this.transport.call("wangp_get_model_metadata", { model_type: modelType }),
      );
      if (metadata) this.metadataCache.set(modelType, metadata);
      return metadata;
    } catch {
      // A model that refuses metadata still works for text-only generation.
      return undefined;
    }
  }

  private async resolveSchema(modelType: string) {
    const cached = this.schemaCache.get(modelType);
    if (cached) return cached;

    const [rawSchema, rawDefaults] = await Promise.all([
      this.transport.call("wangp_get_model_schema", { model_type: modelType }),
      this.transport.call("wangp_get_default_settings", { model_type: modelType }),
    ]);

    const schemaRecord = asRecord(rawSchema) ?? {};
    const defaults = asRecord(rawDefaults) ?? {};
    const metadata = await this.getMetadata(modelType);
    // Capability flags live on metadata, not the settings schema; merge them so
    // image_start/image_end are discoverable as fields.
    if (metadata && schemaRecord.metadata === undefined) schemaRecord.metadata = metadata;

    const normalized = normalizeModelSchema(modelType, schemaRecord, defaults);
    this.schemaCache.set(modelType, normalized);
    return normalized;
  }

  /**
   * WanGP signals keyframe usage through `image_prompt_type` ("S" = start image,
   * "SE" = start + end). Derived from the manifest so callers never hand-code it.
   */
  private applyImagePromptType(
    settings: Record<string, unknown>,
    fieldMap: FieldMap,
  ): Record<string, unknown> {
    if (!fieldMap.image_prompt_type || settings.image_prompt_type !== undefined) return settings;
    const hasStart = Boolean(settings.image_start);
    const hasEnd = Boolean(settings.image_end);
    if (!hasStart && !hasEnd) return settings;
    settings.image_prompt_type = `${hasStart ? "S" : ""}${hasEnd ? "E" : ""}`;
    return settings;
  }
}
