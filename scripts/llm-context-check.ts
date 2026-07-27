import { z } from "zod";
import { computeSegmentation } from "@/lib/duration";
import { buildCreativeBrief, buildStoryPlan, buildVisualBible } from "@/lib/agents/mock-agents";
import { STORYBOARD_SYSTEM } from "@/lib/agents/storyboard-agent";
import { sceneDraftSchema } from "@/lib/schemas/storyboard";
import { withSchemaHint } from "@/lib/agents/llm/schema-hint";
import { config } from "@/lib/config";
import type { Project } from "@/lib/schemas/project";

/**
 * Report how much of the loaded context window each agent prompt consumes, and
 * what `max_tokens` therefore fits.
 *
 *   npx tsx scripts/llm-context-check.ts [sceneCount]
 *
 * LM Studio loads a model at a chosen context length that is usually far below
 * what the model supports, and `prompt + max_tokens` must fit inside it.
 */
const BASE = config.openai.baseUrl || "http://127.0.0.1:1234/v1";

function makeProject(seconds: number): Project {
  const seg = computeSegmentation(seconds);
  const now = new Date().toISOString();
  return {
    id: "ctx-check",
    title: "Context Check",
    concept: "A lighthouse keeper argues with his adult daughter about leaving the island.",
    requestedDurationSeconds: seconds,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "moody",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: true,
    musicRequired: true,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

async function loadedContext(): Promise<{ id: string; loaded: number; max: number } | null> {
  try {
    const res = await fetch(`${BASE.replace("/v1", "")}/api/v0/models`);
    const body = (await res.json()) as {
      data?: { id: string; state?: string; loaded_context_length?: number; max_context_length?: number }[];
    };
    const model = body.data?.find((m) => m.state === "loaded");
    if (!model) return null;
    return {
      id: model.id,
      loaded: model.loaded_context_length ?? 0,
      max: model.max_context_length ?? 0,
    };
  } catch {
    return null;
  }
}

/** Ask the server to count the prompt without generating anything. */
async function promptTokens(model: string, system: string, user: string): Promise<number | null> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { usage?: { prompt_tokens?: number } };
  return body.usage?.prompt_tokens ?? null;
}

/**
 * Generate for real and report what the model actually emitted.
 *
 * `max_tokens` reserves nothing, so a cap far above real output is a weak
 * backstop. Sizing it needs the observed completion length, not the headroom.
 */
async function actualCompletion(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ completion: number; reasoning: number; finish: string } | null> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { reasoning_content?: string | null } }[];
    usage?: { completion_tokens?: number };
  };
  return {
    completion: body.usage?.completion_tokens ?? 0,
    reasoning: body.choices?.[0]?.message?.reasoning_content?.length ?? 0,
    finish: body.choices?.[0]?.finish_reason ?? "?",
  };
}

async function main() {
  const scenes = Number(process.argv[2]) || 3;
  const project = makeProject(scenes * 20);

  const ctx = await loadedContext();
  if (!ctx) throw new Error("No model loaded in LM Studio");
  console.log(`model         : ${ctx.id}`);
  console.log(`loaded context: ${ctx.loaded} tokens  (model supports ${ctx.max})`);
  if (ctx.loaded < ctx.max) {
    console.log(`  note: LM Studio loaded this well below the model maximum.`);
  }

  // The Storyboard agent carries the most context: project + brief + plan + bible.
  const brief = buildCreativeBrief(project);
  const storyPlan = buildStoryPlan(project);
  const visualBible = buildVisualBible(project);
  const system = withSchemaHint(
    STORYBOARD_SYSTEM,
    z.object({ scenes: z.array(sceneDraftSchema) }),
  );
  const user = JSON.stringify({ project, brief, storyPlan, visualBible });

  const tokens = await promptTokens(ctx.id, system, user);
  console.log(`\nStoryboard agent (${project.segmentCount} scenes) — the largest prompt:`);
  console.log(`  system chars : ${system.length}`);
  console.log(`  user chars   : ${user.length}`);
  console.log(`  prompt tokens: ${tokens ?? "?"}`);

  if (tokens) {
    const headroom = ctx.loaded - tokens;
    // Leave a margin: the prompt grows with scene count and story detail.
    const safe = Math.floor((headroom - 1000) / 500) * 500;
    console.log(`\n  headroom for output: ${headroom} tokens`);
    console.log(`  configured OPENAI_MAX_TOKENS: ${config.openai.maxTokens}`);
    console.log(`  safe ceiling (1000 margin) : ${safe}`);
    if (config.openai.maxTokens > headroom) {
      console.log(`\n  WARNING: max_tokens exceeds headroom — output will truncate.`);
      console.log(`  Either lower OPENAI_MAX_TOKENS to ${safe}, or raise LM Studio's`);
      console.log(`  Context Length above ${tokens + config.openai.maxTokens}.`);
    }

    if (process.argv.includes("--generate")) {
      console.log(`\n  generating for real to measure actual output...`);
      const started = Date.now();
      const got = await actualCompletion(ctx.id, system, user, config.openai.maxTokens);
      if (got) {
        const secs = (Date.now() - started) / 1000;
        console.log(`  completion tokens : ${got.completion}`);
        console.log(`  reasoning chars   : ${got.reasoning}`);
        console.log(`  finish_reason     : ${got.finish}`);
        console.log(`  wall time         : ${secs.toFixed(1)}s`);
        const pct = ((got.completion / config.openai.maxTokens) * 100).toFixed(1);
        console.log(`  used ${pct}% of the configured cap`);
        if (got.finish === "length") {
          console.log(`  TRUNCATED — raise OPENAI_MAX_TOKENS.`);
        }
      }
    }
  }
}

void main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
