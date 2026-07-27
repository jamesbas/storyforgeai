import type { WangpJob, WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";
import {
  NUMERIC_FIELDS,
  invertFieldMap,
  resolveFieldMap,
  type FieldMap,
} from "@/lib/wangp/mcp/aliases";

/**
 * Pure normalizers that translate raw WanGP MCP payloads into StoryForgeAI's
 * schema shapes. Ported from easynediacreator `lib/wan-gp/schemas.ts`,
 * `settings-builder.ts`, and `generation-controls.ts`.
 *
 * Nothing here performs I/O, so every mapping rule is unit-testable against
 * captured WanGP payloads without a GPU or a running MCP server.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finite(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function modelDefinition(schema: Record<string, unknown>): Record<string, unknown> {
  return asRecord(schema.model_def) ?? {};
}

function settingValueContainers(schema: Record<string, unknown>): Record<string, unknown>[] {
  const metadata = asRecord(schema.metadata);
  return [asRecord(schema.setting_values), asRecord(metadata?.setting_values)].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  );
}

/**
 * Every settings key the installed model is known to accept. WanGP publishes
 * this across several shapes depending on version, so all of them are merged.
 */
export function knownKeys(
  schema: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Set<string> {
  const keys = new Set(Object.keys(defaults));

  for (const containerName of ["properties", "settings"]) {
    const container = asRecord(schema[containerName]);
    if (container) Object.keys(container).forEach((key) => keys.add(key));
  }

  if (Array.isArray(schema.fields)) {
    for (const field of schema.fields) {
      const item = asRecord(field);
      const name = item?.name ?? item?.key ?? item?.id;
      if (typeof name === "string") keys.add(name);
    }
  }

  for (const container of settingValueContainers(schema)) {
    Object.keys(container).forEach((key) => keys.add(key));
  }

  const modelDef = modelDefinition(schema);
  if (Array.isArray(modelDef.sample_solvers)) keys.add("sample_solver");

  // Media inputs are advertised as capability flags rather than settings keys.
  const metadata = asRecord(schema.metadata) ?? {};
  const mediaInputs = asRecord(metadata.media_inputs) ?? asRecord(modelDef.media_inputs) ?? {};
  const image = asRecord(mediaInputs.image) ?? {};
  if (image.start === true) keys.add("image_start");
  if (image.end === true) keys.add("image_end");
  if (image.reference === true) keys.add("image_refs");
  if (image.control === true) keys.add("image_guide");
  if (image.mask === true) keys.add("image_mask");

  // Continuation source. Verified against a live WanGP: setting `video_source`
  // makes it ffprobe the path, so the key is real even though it never appears
  // in the published defaults.
  const video = asRecord(mediaInputs.video) ?? {};
  if (video.continue === true) keys.add("video_source");

  return keys;
}

function settingDefinition(schema: Record<string, unknown>, key: string): unknown {
  for (const container of settingValueContainers(schema)) {
    if (container[key] !== undefined) return container[key];
  }
  for (const containerName of ["properties", "settings"]) {
    const container = asRecord(schema[containerName]);
    if (container?.[key] !== undefined) return container[key];
  }
  if (Array.isArray(schema.fields)) {
    const field = schema.fields.find((candidate) => {
      const item = asRecord(candidate);
      return item?.name === key || item?.key === key || item?.id === key;
    });
    if (field !== undefined) return field;
  }
  return undefined;
}

export type Choice = { label: string; value: string };

/** WanGP publishes choices as bare arrays, `[label, value]` tuples, or objects. */
export function normalizeChoices(value: unknown): Choice[] {
  const container = asRecord(value);
  const source = container
    ? (container.choices ?? container.options ?? container.values ?? container.enum ?? value)
    : value;
  if (!Array.isArray(source)) return [];

  const choices = source.flatMap((entry): Choice[] => {
    if (typeof entry === "string" || typeof entry === "number") {
      return [{ label: String(entry), value: String(entry) }];
    }
    if (Array.isArray(entry) && entry.length >= 2) {
      return [{ label: String(entry[0]), value: String(entry[1]) }];
    }
    const item = asRecord(entry);
    if (!item) return [];
    const choiceValue = item.value ?? item.id ?? item.key ?? item.name;
    if (typeof choiceValue !== "string" && typeof choiceValue !== "number") return [];
    return [{ label: String(item.label ?? item.name ?? choiceValue), value: String(choiceValue) }];
  });

  return [...new Map(choices.filter((c) => c.value.length > 0).map((c) => [c.value, c])).values()];
}

export function choicesFor(
  schema: Record<string, unknown>,
  key: string,
  modelKeys: string[] = [],
): Choice[] {
  const sources = [
    settingDefinition(schema, key),
    ...modelKeys.map((modelKey) => modelDefinition(schema)[modelKey]),
    ...modelKeys.map((modelKey) => schema[modelKey]),
  ];
  for (const source of sources) {
    const choices = normalizeChoices(source);
    if (choices.length) return choices;
  }
  return [];
}

export type NumericRange = { min?: number; max?: number; step?: number };

function firstNumber(sources: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = finite(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/** Extract a published min/max/step for a setting, when the schema declares one. */
export function numericRange(
  schema: Record<string, unknown>,
  key: string,
  modelKeys: string[] = [],
): NumericRange {
  const sources = [
    settingDefinition(schema, key),
    ...modelKeys.map((modelKey) => modelDefinition(schema)[modelKey]),
    ...modelKeys.map((modelKey) => schema[modelKey]),
  ]
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => Boolean(value));

  const min = firstNumber(sources, ["min", "minimum"]);
  const max = firstNumber(sources, ["max", "maximum"]);
  const step = firstNumber(sources, ["step", "increment", "inc"]);
  return {
    min,
    max,
    step: step !== undefined && step > 0 ? step : undefined,
  };
}

const INPUT_KINDS = ["text", "image", "video", "audio"] as const;
type InputKind = (typeof INPUT_KINDS)[number];

function pick(...sources: (Record<string, unknown> | undefined)[]): (...keys: string[]) => unknown {
  return (...keys: string[]) => {
    for (const source of sources) {
      if (!source) continue;
      for (const key of keys) {
        if (source[key] !== undefined) return source[key];
      }
    }
    return undefined;
  };
}

function normalizeInputs(value: unknown): InputKind[] {
  const allowed = new Set<string>(INPUT_KINDS);
  if (Array.isArray(value)) {
    return value.filter((item): item is InputKind => typeof item === "string" && allowed.has(item));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record).filter((key): key is InputKind => allowed.has(key) && Boolean(record[key]));
}

/**
 * Derive input kinds from a `media_inputs` map.
 *
 * WanGP always emits all three groups (`image`, `video`, `audio`) with a full
 * set of boolean flags, so the group's mere presence means nothing — a kind
 * only counts as an input when one of its flags is actually true. The `output`
 * flag is excluded because it describes what the model produces.
 */
function inputsFromMediaInputs(value: unknown): InputKind[] {
  const record = asRecord(value);
  if (!record) return [];
  const kinds: InputKind[] = [];
  for (const kind of INPUT_KINDS) {
    const group = asRecord(record[kind]);
    if (!group) continue;
    const usable = Object.entries(group).some(([flag, flagValue]) => flag !== "output" && flagValue === true);
    if (usable) kinds.push(kind);
  }
  return kinds;
}

/**
 * Map a `wangp_list_models` entry (optionally enriched with
 * `wangp_get_model_metadata`) onto StoryForgeAI's `WangpModel`.
 *
 * Returns null for entries whose main output is not one the app can consume,
 * so unknown WanGP workflows are skipped rather than crashing discovery.
 */
export function normalizeModel(
  entry: unknown,
  metadata?: Record<string, unknown>,
): WangpModel | null {
  const source = asRecord(entry);
  if (!source) return null;

  const read = pick(source, metadata);
  const modelType = read("modelType", "model_type");
  if (typeof modelType !== "string" || !modelType) return null;

  const rawOutput = read("main_output", "mainOutput", "output");
  const outputValue = Array.isArray(rawOutput)
    ? rawOutput.find((item) => item === "image" || item === "video" || item === "audio")
    : rawOutput;
  if (outputValue !== "image" && outputValue !== "video" && outputValue !== "audio") return null;

  // `outputs` widens `main_output`: WanGP appends "audio" for models with
  // `returns_audio` (LTX-2, Ovi, Hunyuan avatar, …) while main_output stays
  // "video". Without this, a soundtrack-producing model looks silent.
  const rawOutputs = read("outputs");
  const outputs = (Array.isArray(rawOutputs) ? rawOutputs : [outputValue]).filter(
    (item): item is "image" | "video" | "audio" =>
      item === "image" || item === "video" || item === "audio",
  );

  const mediaInputs = asRecord(read("media_inputs", "mediaInputs"));
  const image = asRecord(mediaInputs?.image);
  const audio = asRecord(mediaInputs?.audio);
  const video = asRecord(mediaInputs?.video);

  const inputs = new Set<InputKind>(normalizeInputs(read("inputs")));
  for (const kind of inputsFromMediaInputs(mediaInputs)) inputs.add(kind);
  inputs.add("text"); // every WanGP workflow accepts a prompt

  const modelDef = asRecord(read("model_def")) ?? {};
  const loraFlag = read("supports_lora", "supportsLora", "loras") ?? modelDef.loras;
  const maxFrames = finite(read("max_frames", "maxFrames", "frames_max") ?? modelDef.max_frames);
  const rawFps = read("recommended_fps", "recommendedFps") ?? modelDef.fps;
  const recommendedFps = Array.isArray(rawFps)
    ? rawFps.map(finite).filter((n): n is number => n !== undefined)
    : undefined;

  const name = read("name");

  const audioOutput = audio?.output === true || outputs.includes("audio");
  const audioPrompt = audio?.prompt === true;

  // WanGP reports availability either as a bare string or as { status, reason }.
  const rawAvailability = read("availability");
  const availabilityValue =
    asRecord(rawAvailability)?.status ?? (typeof rawAvailability === "string" ? rawAvailability : undefined);
  const availability =
    availabilityValue === "available" || availabilityValue === "partial" || availabilityValue === "missing"
      ? availabilityValue
      : undefined;

  return {
    modelType,
    name: typeof name === "string" && name ? name : modelType,
    metadata: {
      mainOutput: outputValue,
      ...(outputs.length ? { outputs: [...new Set(outputs)] } : {}),
      inputs: [...inputs],
      ...(image || audio || video
        ? {
            mediaInputs: {
              ...(image
                ? {
                    image: {
                      start: image.start === true,
                      end: image.end === true,
                      reference: image.reference === true,
                    },
                  }
                : {}),
              ...(audioOutput || audioPrompt
                ? { audio: { prompt: audioPrompt, output: audioOutput } }
                : {}),
              ...(video
                ? { video: { continue: video.continue === true, last: video.last === true } }
                : {}),
            },
          }
        : {}),
      ...(loraFlag === undefined ? {} : { supportsLora: Boolean(loraFlag) }),
      ...(availability ? { availability } : {}),
      ...(maxFrames === undefined ? {} : { maxFrames }),
      ...(recommendedFps?.length ? { recommendedFps } : {}),
    },
  };
}

function fieldTypeFor(canonical: string, defaultValue: unknown): string {
  if (NUMERIC_FIELDS.has(canonical)) return "number";
  if (typeof defaultValue === "number") return "number";
  if (typeof defaultValue === "boolean") return "boolean";
  if (Array.isArray(defaultValue)) return "array";
  return "string";
}

export type NormalizedSchema = { schema: WangpModelSchema; fieldMap: FieldMap };

/**
 * Fold `wangp_get_model_schema` + `wangp_get_default_settings` into the app's
 * `WangpModelSchema`, renaming every discovered alias to its canonical name.
 *
 * `defaultSettings` keeps *all* model defaults (not just canonical ones) because
 * WanGP expects a complete settings payload; the live client renames the
 * canonical subset back before submitting.
 */
export function normalizeModelSchema(
  modelType: string,
  rawSchema: Record<string, unknown>,
  defaults: Record<string, unknown>,
): NormalizedSchema {
  const keys = knownKeys(rawSchema, defaults);
  const fieldMap = resolveFieldMap(keys);
  const actualToCanonical = invertFieldMap(fieldMap);

  const defaultSettings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    defaultSettings[actualToCanonical[key] ?? key] = value;
  }
  defaultSettings.model_type = modelType;

  const fields: WangpModelSchema["fields"] = Object.entries(fieldMap).map(([canonical, actual]) => {
    const type = fieldTypeFor(canonical, defaults[actual]);
    const choices = choicesFor(rawSchema, actual, [`${actual}s`]);
    const range = numericRange(rawSchema, actual, [`${actual}_slider`]);

    const allowed = choices.length
      ? type === "number"
        ? choices.map((c) => finite(c.value)).filter((n): n is number => n !== undefined)
        : choices.map((c) => c.value)
      : undefined;

    return {
      name: canonical,
      type,
      ...(allowed?.length ? { allowed } : {}),
      ...(type === "number" && range.min !== undefined ? { min: range.min } : {}),
      ...(type === "number" && range.max !== undefined ? { max: range.max } : {}),
      ...(type === "number" && range.step !== undefined ? { step: range.step } : {}),
    };
  });

  return { schema: { modelType, defaultSettings, fields }, fieldMap };
}

const EVENT_STATUSES = ["submitted", "running", "completed", "failed", "cancelled"] as const;

function coerceStatus(value: unknown): WangpJob["status"] | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "queued" || value === "pending") return "submitted";
  return (EVENT_STATUSES as readonly string[]).includes(value)
    ? (value as WangpJob["status"])
    : undefined;
}

/**
 * Map a `wangp_get_job` payload onto `WangpJob`.
 *
 * WanGP's current MCP server reports an event log plus a terminal `result`
 * rather than a status string, so status is derived the same way
 * easynediacreator derives it. A flat `{ status, progress }` payload is also
 * accepted for older/alternate server builds.
 */
export function normalizeJob(value: unknown, fallbackId?: string): WangpJob {
  const source = asRecord(value);
  if (!source) throw new Error("WanGP returned an unrecognized job payload.");

  const id =
    (typeof source.job_id === "string" && source.job_id) ||
    (typeof source.jobId === "string" && source.jobId) ||
    (typeof source.id === "string" && source.id) ||
    fallbackId;
  if (!id) throw new Error("WanGP job payload is missing a job id.");

  const events = Array.isArray(source.events) ? source.events.map(asRecord) : [];
  const result = asRecord(source.result);
  const hasEventShape = typeof source.done === "boolean";

  const generatedFiles = (() => {
    const raw = result?.generated_files ?? source.generated_files ?? source.outputPaths;
    return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
  })();

  const errors = (() => {
    const raw = result?.errors ?? source.errors;
    if (!Array.isArray(raw)) return typeof source.error === "string" ? [source.error] : [];
    return raw
      .map((item) => (typeof item === "string" ? item : asRecord(item)?.message))
      .filter((m): m is string => typeof m === "string");
  })();

  const latestProgress = [...events]
    .reverse()
    .find((event) => event?.kind === "progress")?.data;
  const progressFromEvent = finite(asRecord(latestProgress)?.progress);

  let status: WangpJob["status"];
  if (hasEventShape) {
    if (!source.done) {
      // WanGP does not always emit a "started" event, but any progress report
      // means the job is under way — otherwise a job at 68% still reads as
      // "submitted".
      const started =
        events.some((event) => event?.kind === "started") ||
        (progressFromEvent ?? 0) > 0 ||
        events.some((event) => event?.kind === "progress" || event?.kind === "stream");
      status = started ? "running" : "submitted";
    } else if (result?.cancelled === true) {
      status = "cancelled";
    } else {
      status = result?.success === true ? "completed" : "failed";
    }
  } else {
    status = coerceStatus(source.status) ?? (generatedFiles.length ? "completed" : "running");
  }

  const progress =
    status === "completed"
      ? 100
      : Math.min(100, Math.max(0, progressFromEvent ?? finite(source.progress) ?? 0));

  return { id, status, progress, generatedFiles, errors };
}
