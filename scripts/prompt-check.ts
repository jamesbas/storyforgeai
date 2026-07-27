import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { createProject, generateStoryboard } from "@/lib/services/project-service";

/** Show the prompts actually produced for a multi-scene story. */
async function main() {
  const provider = getPlanningProvider();
  console.log(`provider: ${provider?.name ?? "NONE (deterministic builders)"}`);

  const project = await createProject({
    concept: "A lighthouse keeper argues with his adult daughter about leaving the island.",
    requestedDurationSeconds: 60,
    dialogueRequired: true,
    tone: "moody",
    style: "cinematic",
  });
  const started = Date.now();
  const record = await generateStoryboard(project.id);
  console.log(`storyboard generated in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  for (const scene of record.storyboard!.scenes) {
    console.log(`--- SCENE ${scene.sceneNumber}: ${scene.title}`);
    console.log(`DIALOGUE : ${JSON.stringify(scene.dialogue ?? null)}`);
    console.log(`START    : ${scene.prompts.startFramePrompt}`);
    console.log(`VIDEO    : ${scene.prompts.videoPromptSegment}\n`);
  }

  const videoPrompts = new Set(record.storyboard!.scenes.map((s) => s.prompts.videoPromptSegment));
  console.log(`distinct video prompts: ${videoPrompts.size} / ${record.storyboard!.scenes.length}`);
}

void main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
