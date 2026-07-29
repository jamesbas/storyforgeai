import type { ZodType, ZodTypeDef } from "zod";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { withSchemaHint } from "@/lib/agents/llm/schema-hint";

/**
 * Planning provider abstraction. The deterministic pipeline runs without any
 * provider; when AI planning is enabled and a key is present, a real provider
 * supplies JSON that is validated against the artifact's Zod schema. Providers
 * are null-tolerant: any failure returns null so callers fall back to the
 * deterministic builder (generic-build-spec Section 5.3).
 */
export interface PlanningProvider {
  readonly name: string;
  // Input is left `unknown` so `T` binds to the schema's parsed output. A schema
  // with a defaulted field has a wider input than output, and binding to both
  // hands the caller a type where that field is still optional.
  generateJson<T>(system: string, user: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | null>;
}

/**
 * OpenAI-compatible provider. Works against the OpenAI API or any compatible
 * local server (LM Studio, Ollama, llama.cpp) by pointing OPENAI_BASE_URL at it.
 *
 * The SDK is loaded via a guarded dynamic import with a non-literal specifier so
 * a missing package degrades to the deterministic builders instead of crashing.
 */
type ChatMessage = { role: "system" | "user"; content: string };
type ChatChoice = {
  message?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
};
type ChatResponse = { choices?: ChatChoice[] };
type ResponseFormat =
  | { type: "json_object" }
  | { type: "text" }
  | { type: "json_schema"; json_schema: Record<string, unknown> };
interface OpenAiClient {
  chat: {
    completions: {
      create(
        args: {
          model: string;
          messages: ChatMessage[];
          response_format?: ResponseFormat;
          temperature?: number;
          max_tokens?: number;
        },
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<ChatResponse>;
    };
  };
}
type OpenAiCtor = new (opts: {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
}) => OpenAiClient;

/**
 * Small local models often wrap JSON in prose or a fenced block even when asked
 * for raw JSON. Reasoning models may also inline a <think> block in the content
 * rather than splitting it into `reasoning_content`. Recover the JSON either way.
 */
export function extractJsonObject(content: string): unknown | null {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const trimmed = withoutThinking || content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          // fall through to the next candidate
        }
      }
    }
  }
  return null;
}

/**
 * Whether a failure is the server rejecting the response_format we asked for.
 * LM Studio, for example, accepts only `json_schema` or `text`.
 */
export function isResponseFormatRejection(message: string): boolean {
  return /response_format|json_schema|response format/i.test(message);
}

/**
 * Preference order for how we ask for JSON, best first.
 *
 * `json_schema` constrains generation to the artifact's exact shape, which is
 * the only reliable way to get a small local model to produce a conforming
 * object — without it they return plausible JSON with the wrong keys. A server
 * that rejects a format steps down one rung, once per process.
 */
const FORMAT_LADDER = ["json_schema", "json_object", "text"] as const;
type FormatKind = (typeof FORMAT_LADDER)[number];

function initialFormat(): FormatKind {
  const configured = config.openai.responseFormat;
  return (FORMAT_LADDER as readonly string[]).includes(configured)
    ? (configured as FormatKind)
    : FORMAT_LADDER[0];
}

let formatKind: FormatKind = initialFormat();

/** Build a `json_schema` response format from a Zod schema, or null if unsupported. */
async function jsonSchemaFormat<T>(schema: ZodType<T>, name: string): Promise<ResponseFormat | null> {
  try {
    const specifier = "openai/helpers/zod";
    const helper = (await import(/* webpackIgnore: true */ specifier).catch(() => null)) as {
      zodResponseFormat?: (s: ZodType<T>, n: string) => ResponseFormat;
    } | null;
    if (!helper?.zodResponseFormat) return null;
    return helper.zodResponseFormat(schema, name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60));
  } catch {
    // Schemas using records, unions, or defaults may not convert; fall back.
    return null;
  }
}

function createOpenAiProvider(): PlanningProvider {
  const label = config.openai.baseUrl ? "openai-compatible" : "openai";

  return {
    name: label,
    async generateJson<T>(
      system: string,
      user: string,
      schema: ZodType<T, ZodTypeDef, unknown>,
    ): Promise<T | null> {
      const fail = (reason: string, extra: Record<string, unknown> = {}) => {
        logEvent("agent.llm.failed", { provider: label, reason, ...extra });
        return null;
      };

      try {
        const specifier = "openai";
        const imported = await import(/* webpackIgnore: true */ specifier).catch(() => null);
        const mod = imported as { default?: OpenAiCtor; OpenAI?: OpenAiCtor } | null;
        const Ctor = mod?.default ?? mod?.OpenAI;
        if (!Ctor) return fail("sdk_missing");

        const client = new Ctor({
          // Local servers ignore the key but the SDK requires a non-empty value.
          apiKey: config.openai.apiKey || "local",
          ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
          timeout: config.openai.timeoutMs,
          maxRetries: 1,
        });

        const messages: ChatMessage[] = [
          // Agent prompts name a schema the model has never seen, so spell out
          // the expected keys. Without this, small local models return
          // plausible JSON with the wrong shape.
          { role: "system", content: withSchemaHint(system, schema) },
          { role: "user", content: user },
        ];
        // Name the schema after the agent so server-side logs stay traceable.
        const schemaName = system.slice(0, 40);

        const call = (format: ResponseFormat | null) =>
          client.chat.completions.create(
            {
              model: config.openai.model,
              messages,
              ...(format ? { response_format: format } : {}),
              temperature: config.openai.temperature,
              // Reasoning models spend this budget thinking before any content.
              max_tokens: config.openai.maxTokens,
            },
            { timeout: config.openai.timeoutMs },
          );

        let res: ChatResponse | null = null;
        for (let attempt = 0; attempt < FORMAT_LADDER.length && res === null; attempt += 1) {
          const format =
            formatKind === "json_schema"
              ? await jsonSchemaFormat(schema, schemaName)
              : ({ type: formatKind } as ResponseFormat);

          if (formatKind === "json_schema" && !format) {
            // This schema cannot be expressed as JSON Schema; drop a rung.
            formatKind = "json_object";
            continue;
          }

          try {
            res = await call(format);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const index = FORMAT_LADDER.indexOf(formatKind);
            if (!isResponseFormatRejection(message) || index >= FORMAT_LADDER.length - 1) {
              return fail("request_failed", { message, format: formatKind });
            }
            logEvent("agent.llm.failed", {
              provider: label,
              reason: "format_unsupported",
              format: formatKind,
              message,
            });
            formatKind = FORMAT_LADDER[index + 1]!;
          }
        }
        if (res === null) return fail("request_failed", { message: "no usable response format" });

        const choice = res.choices?.[0];
        const content = choice?.message?.content ?? undefined;
        if (!content) {
          // Some servers accept json_schema but return nothing under it with a
          // reasoning model — the format is "supported" yet unusable, so step
          // down rather than failing every call for the rest of the process.
          const index = FORMAT_LADDER.indexOf(formatKind);
          if (choice?.finish_reason === "stop" && index < FORMAT_LADDER.length - 1) {
            logEvent("agent.llm.failed", {
              provider: label,
              reason: "format_produced_no_content",
              format: formatKind,
              reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
            });
            formatKind = FORMAT_LADDER[index + 1]!;
          }
          // A reasoning model spends max_tokens on thinking before it emits any
          // content, so an exhausted budget looks like an empty reply. Surface
          // finish_reason so that is diagnosable rather than mysterious.
          return fail("empty_response", {
            finishReason: choice?.finish_reason ?? "unknown",
            reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
            ...(choice?.finish_reason === "length"
              ? { hint: "raise OPENAI_MAX_TOKENS; reasoning tokens count toward it" }
              : {}),
          });
        }

        const json = extractJsonObject(content);
        if (json === null) {
          // Truncation and garbage look alike in the sample, but need opposite
          // fixes: finish_reason=length means the budget ran out mid-object
          // (raise max_tokens), anything else means malformed output.
          return fail("unparseable_json", {
            finishReason: choice?.finish_reason ?? "unknown",
            contentChars: content.length,
            reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
            ...(choice?.finish_reason === "length"
              ? { hint: "response truncated; raise OPENAI_MAX_TOKENS" }
              : {}),
            sample: content.slice(0, 200),
          });
        }

        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          // Distinct from a transport failure: the model answered, but not in
          // the shape the artifact requires. Silently falling back here is how
          // a local model can look like it is working when it is not.
          return fail("schema_mismatch", {
            format: formatKind,
            issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        return parsed.data;
      } catch (err) {
        return fail("request_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/** Reset negotiated JSON mode (tests, or after changing servers). */
export function resetResponseFormat(): void {
  formatKind = initialFormat();
}

/**
 * Serialize planning calls when the provider is a local server.
 *
 * LM Studio and its peers serve with limited parallelism: firing several
 * structured-output calls at one local model is slower than issuing them in
 * turn, and on a single GPU can exhaust VRAM outright. Nothing in the app
 * prevented that — the Agentic Canvas disables only the button you clicked, so
 * four agents could be started at once and collide inside the model.
 *
 * A hosted API has no such limit and would only be slowed by this, so the chain
 * engages solely when a local base URL is configured. Held on `globalThis` so a
 * module reload cannot hand out a second chain and defeat the point.
 */
const planningQueue = globalThis as unknown as { __storyforgePlanningQueue?: Promise<unknown> };

/** Exported for tests: the serialization is invisible when it regresses. */
export function enqueuePlanning<T>(task: () => Promise<T>): Promise<T> {
  if (!config.openai.baseUrl) return task();
  const previous = planningQueue.__storyforgePlanningQueue ?? Promise.resolve();
  // Swallow a predecessor's failure so one bad call cannot poison the chain.
  const run = previous.catch(() => undefined).then(task);
  planningQueue.__storyforgePlanningQueue = run.catch(() => undefined);
  return run;
}

/**
 * Returns the active provider, or null when AI planning is disabled or
 * unconfigured (the default demo path). A base URL alone is enough for a local
 * server, which needs no API key.
 *
 * Wrapping here rather than inside the provider means every consumer is
 * serialized by construction, including callers that fan out per scene.
 */
export function getPlanningProvider(): PlanningProvider | null {
  if (!config.flags.aiPlanning) return null;
  if (!config.openai.apiKey && !config.openai.baseUrl) return null;

  const provider = createOpenAiProvider();
  return {
    name: provider.name,
    generateJson: (system, user, schema) =>
      enqueuePlanning(() => provider.generateJson(system, user, schema)),
  };
}
