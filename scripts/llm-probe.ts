import { z } from "zod";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { config } from "@/lib/config";

/**
 * Single-call LLM probe: checks the model id, latency, and whether the reply
 * conforms to a StoryForge-shaped schema. Much faster than a full storyboard.
 *
 *   npx tsx scripts/llm-probe.ts
 */
const schema = z.object({
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
  imageNegativePrompt: z.string(),
});

const SYSTEM =
  "You are the Image Prompt Agent. For the given scene, create a start-frame image prompt " +
  "and end-frame image prompt following the Visual Bible and preserving continuity. Include " +
  "a negative prompt. Return only valid JSON with exactly these string keys: " +
  "startFramePrompt, endFramePrompt, imageNegativePrompt.";

const USER = JSON.stringify({
  project: { style: "cinematic", tone: "moody" },
  scene: {
    sceneNumber: 1,
    visualDescription: "A lighthouse keeper watches a storm roll in over a dark sea.",
    actionDescription: "The keeper steps to the window as the first rain hits the glass.",
    cameraMovement: "slow push-in",
  },
});

async function main() {
  const provider = getPlanningProvider();
  console.log(`provider : ${provider?.name ?? "NONE"}`);
  console.log(`model    : ${config.openai.model}`);
  console.log(`baseUrl  : ${config.openai.baseUrl || "(default OpenAI)"}`);
  console.log(`maxTokens: ${config.openai.maxTokens}  timeout: ${config.openai.timeoutMs}ms`);
  if (!provider) return;

  const t0 = Date.now();
  const result = await provider.generateJson(SYSTEM, USER, schema);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result) {
    console.log(`\nRESULT: null after ${seconds}s — see agent.llm.failed above for the reason.`);
    return;
  }
  console.log(`\nRESULT: schema-valid in ${seconds}s`);
  console.log(`  startFramePrompt: ${result.startFramePrompt.slice(0, 160)}`);
  console.log(`  endFramePrompt  : ${result.endFramePrompt.slice(0, 160)}`);
  console.log(`  negative        : ${result.imageNegativePrompt.slice(0, 120)}`);
}

void main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
