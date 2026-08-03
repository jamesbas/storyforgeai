import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Print the deterministic prompts for one scene under both composer versions,
 * per model family (SPEC-003 §17.3).
 *
 * This is the diff a reviewer reads before authorising fixed-seed renders. The
 * work happens in a child process per flag state because `lib/config.ts` reads
 * the environment once at module load.
 */

const FAMILIES_IMAGE = ["flux", "qwen", "krea"] as const;
const FAMILIES_VIDEO = ["wan", "ltx"] as const;

async function emit() {
  const { buildImagePrompts, buildVideoPrompts } = await import("@/lib/agents/mock-agents");
  const { config } = await import("@/lib/config");

  const project = {
    id: "preview",
    segmentCount: 3,
    segmentSeconds: 5,
    style: "cinematic",
    tone: "moody",
  } as never;

  const scene = {
    id: "preview-scene-002",
    projectId: "preview",
    sceneNumber: 2,
    startTimeSeconds: 5,
    endTimeSeconds: 10,
    targetDurationSeconds: 5,
    title: "The turn",
    sceneObjective: "Commit to the repair",
    storyBeat: "The apprentice commits to the repair",
    visualDescription: "Medium close-up of the apprentice at the bench, low angle",
    actionDescription: "She seats the gear with a firm clockwise turn. The scarf whips left.",
    cameraMovement: "Slow push-in on the subject.",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    dialogue: [{ character: "Ana", line: "Then we decide now." }],
    status: "draft",
  } as never;

  const label = config.flags.mediaPromptComposerV2 ? "v2" : "v1";
  for (const family of FAMILIES_IMAGE) {
    const p = buildImagePrompts(project, scene, [], undefined, undefined, family);
    console.log(`\n[${label}] ${family} · start frame\n${p.startFramePrompt}`);
  }
  for (const family of FAMILIES_VIDEO) {
    const p = buildVideoPrompts(project, scene, [], undefined, undefined, family);
    console.log(`\n[${label}] ${family} · video\n${p.videoPromptSegment}`);
  }
}

function main() {
  if (process.env.PROMPT_PREVIEW_CHILD === "1") {
    void emit();
    return;
  }
  const self = fileURLToPath(import.meta.url);
  for (const enabled of ["false", "true"]) {
    console.log(`\n${"=".repeat(70)}\nMEDIA_PROMPT_COMPOSER_V2=${enabled}\n${"=".repeat(70)}`);
    const result = spawnSync(process.execPath, ["--import", "tsx", self], {
      stdio: "inherit",
      env: { ...process.env, PROMPT_PREVIEW_CHILD: "1", MEDIA_PROMPT_COMPOSER_V2: enabled },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

main();
