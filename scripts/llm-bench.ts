import { config } from "@/lib/config";

/**
 * Token-throughput benchmark for an OpenAI-compatible server.
 *
 *   npx tsx scripts/llm-bench.ts <modelId> [<modelId> ...]
 *
 * Wall-clock time alone is misleading: a reasoning model's answer length varies
 * run to run, so a "faster" model may simply have thought less. This reports
 * completion tokens and tokens/sec so throughput is comparable.
 *
 * Each model gets a short warmup first, because the first request after a
 * switch includes load time that is not generation speed.
 */
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};
type Response = {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: Usage;
};

const BASE = config.openai.baseUrl || "http://127.0.0.1:1234/v1";

const SYSTEM =
  "You are the Image Prompt Agent. For the given scene, create a start-frame image prompt " +
  "and end-frame image prompt following the Visual Bible and preserving continuity. Include " +
  "a negative prompt.\n\nReturn a single JSON object with exactly this shape (keys marked ? " +
  "are optional, all others are required):\n" +
  "{ startFramePrompt: string, endFramePrompt: string, imageNegativePrompt: string }\n" +
  "Do not wrap it in another object and do not add commentary.";

const USER = JSON.stringify({
  project: { style: "cinematic", tone: "moody" },
  scene: {
    sceneNumber: 1,
    visualDescription: "A lighthouse keeper watches a storm roll in over a dark sea.",
    actionDescription: "The keeper steps to the window as the first rain hits the glass.",
    cameraMovement: "slow push-in",
  },
});

async function call(model: string, maxTokens: number) {
  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      temperature: config.openai.temperature,
      max_tokens: maxTokens,
    }),
  });
  const elapsed = (Date.now() - started) / 1000;
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Response;
  return { elapsed, body };
}

function parses(content: string | null | undefined): boolean {
  if (!content) return false;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    return (
      typeof parsed.startFramePrompt === "string" &&
      typeof parsed.endFramePrompt === "string" &&
      typeof parsed.imageNegativePrompt === "string"
    );
  } catch {
    return false;
  }
}

async function main() {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error("usage: llm-bench.ts <modelId> [<modelId> ...]");
  console.log(`endpoint: ${BASE}\nmax_tokens: ${config.openai.maxTokens}\n`);

  for (const model of models) {
    console.log(`=== ${model} ===`);
    try {
      // Warmup: absorbs model load/swap so it is not counted as throughput.
      const warm = Date.now();
      await call(model, 16);
      console.log(`  warmup (load+swap): ${((Date.now() - warm) / 1000).toFixed(1)}s`);

      const { elapsed, body } = await call(model, config.openai.maxTokens);
      const usage = body.usage ?? {};
      const completion = usage.completion_tokens ?? 0;
      const reasoning = usage.completion_tokens_details?.reasoning_tokens;
      const content = body.choices?.[0]?.message?.content;
      const reasoningChars = body.choices?.[0]?.message?.reasoning_content?.length ?? 0;

      console.log(`  wall time        : ${elapsed.toFixed(1)}s`);
      console.log(`  prompt tokens    : ${usage.prompt_tokens ?? "?"}`);
      console.log(`  completion tokens: ${completion}${reasoning ? ` (reasoning ${reasoning})` : ""}`);
      console.log(`  reasoning chars  : ${reasoningChars}`);
      console.log(`  throughput       : ${completion ? (completion / elapsed).toFixed(1) : "?"} tok/s`);
      console.log(`  usable JSON      : ${parses(content) ? "yes" : "NO"}`);
    } catch (e) {
      console.log(`  FAILED: ${e instanceof Error ? e.message : e}`);
    }
    console.log("");
  }
}

void main().catch((e) => {
  console.error("BENCH FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
