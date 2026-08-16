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

  async listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]> {
    if (!this.modelCache || Date.now() - this.modelCache.at >= MODEL_CACHE_TTL_MS) {
      const raw = await this.transport.call("wangp_list_models", { include_availability: true });
      const entries = Array.isArray(raw) ? raw : [];

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

      this.modelCache = { at: Date.now(), models };
      logEvent("wangp.discovery", { mode: "live", count: models.length });
    }

    const models = this.modelCache.models;
    return mainOutput ? models.filter((m) => produces(m, mainOutput)) : models;
  }

  /** Drop the cached catalogue, for an explicit refresh. */
  resetModelCache(): void {
    this.modelCache = undefined;
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
