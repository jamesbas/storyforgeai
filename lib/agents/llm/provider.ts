import type { ZodType } from "zod";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

/**
 * Planning provider abstraction. The deterministic pipeline runs without any
 * provider; when AI planning is enabled and a key is present, a real provider
 * supplies JSON that is validated against the artifact's Zod schema. Providers
 * are null-tolerant: any failure returns null so callers fall back to the
 * deterministic builder (generic-build-spec Section 5.3).
 */
export interface PlanningProvider {
  readonly name: string;
  generateJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T | null>;
}

/**
 * OpenAI-backed provider. The SDK is imported via a guarded dynamic import with a
 * non-literal specifier so the package is not a hard dependency and local runs
 * need zero cloud packages. If anything fails, it returns null.
 */
type ChatMessage = { role: "system" | "user"; content: string };
type ChatResponse = { choices?: Array<{ message?: { content?: string | null } }> };
interface OpenAiClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: ChatMessage[];
        response_format: { type: "json_object" };
      }): Promise<ChatResponse>;
    };
  };
}
type OpenAiCtor = new (opts: { apiKey: string }) => OpenAiClient;

function createOpenAiProvider(): PlanningProvider {
  return {
    name: "openai",
    async generateJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T | null> {
      try {
        const specifier = "openai";
        const imported = await import(/* webpackIgnore: true */ specifier).catch(() => null);
        const mod = imported as { default?: OpenAiCtor; OpenAI?: OpenAiCtor } | null;
        const Ctor = mod?.default ?? mod?.OpenAI;
        if (!Ctor) return null;

        const client = new Ctor({ apiKey: config.openai.apiKey });
        const res = await client.chat.completions.create({
          model: config.openai.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
        });
        const content = res.choices?.[0]?.message?.content ?? undefined;
        if (!content) return null;
        const parsed = schema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data : null;
      } catch (err) {
        logEvent("agent.run", { provider: "openai", error: String(err) });
        return null;
      }
    },
  };
}

/**
 * Returns the active provider, or null when AI planning is disabled or
 * unconfigured (the default demo path).
 */
export function getPlanningProvider(): PlanningProvider | null {
  if (!config.flags.aiPlanning || !config.openai.apiKey) return null;
  return createOpenAiProvider();
}
