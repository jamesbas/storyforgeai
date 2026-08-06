import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The rollout gate for `H3_NATIVE_PROMPT_FORMAT`.
 *
 * Prints the exact prompt a real scene would send to MiniMax H3 with the flag
 * off and on, and with `--render` submits both to WanGP so the two clips can be
 * watched side by side.
 *
 *   npm run h3:ab -- <projectId> [sceneNumber]            # prompts only, free
 *   npm run h3:ab -- <projectId> [sceneNumber] --render   # + two clips
 *
 * `--start=<path>` and `--end=<path>` override the attempt's keyframes without
 * touching the record. FL2VA is only meaningful when the two frames belong to
 * the same shot — MiniMax's guide asks for "compatible subjects, perspective,
 * proportions, and style" — so a scene carrying an unrelated imported frame has
 * to borrow a coherent pair to be worth rendering.
 *
 * **There is no fixed seed.** `minimax_h3_fl2va` declares no seed field, and
 * `buildVideoManifest` has never passed one for any family, so the two arms
 * differ by sampling as well as by prompt. Judge this on outcomes that are
 * pass/fail rather than prettier/uglier: does the speech get spoken, does
 * ambience stay out of the score, does the clip land on the end frame, and do
 * none of the field labels appear as text in the picture.
 *
 * A child process per flag state, because `lib/config.ts` reads the environment
 * once at module load.
 */

/** The only H3 variant that is both downloaded and takes a start and end frame. */
const MODEL = process.env.H3_AB_MODEL ?? "minimax_h3_fl2va_pruned";

const flagValue = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function emit() {
  const projectId = process.argv[2];
  const sceneNumber = Number(process.argv[3] ?? 1);
  const render = process.argv.includes("--render");
  if (!projectId) throw new Error("usage: h3-format-ab.ts <projectId> [sceneNumber] [--render]");

  const { getProjectRecord } = await import("@/lib/services/project-service");
  const { buildVideoManifest, runToCompletion } = await import("@/lib/services/wangp-service");
  const { config } = await import("@/lib/config");
  const record = await getProjectRecord(projectId);
  const scene = record.storyboard?.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!scene) throw new Error(`Scene ${sceneNumber} not found in ${projectId}`);

  const attempt = (record.attempts?.[scene.id] ?? []).at(-1);
  const imageStart = flagValue("start") ?? attempt?.startImagePath;
  const imageEnd = flagValue("end") ?? attempt?.endImagePath;
  if (!imageStart || !imageEnd) {
    throw new Error(
      `Scene ${sceneNumber} needs both keyframes; generate its media first, or pass --start= and --end=.`,
    );
  }
  console.log(`start frame: ${imageStart}\nend frame  : ${imageEnd}`);

  const label = config.flags.h3NativePromptFormat ? "ON " : "OFF";
  const manifest = await buildVideoManifest({
    sceneId: scene.id,
    prompt: scene.prompts.videoPromptSegment,
    negativePrompt: scene.prompts.videoNegativePrompt,
    imageStart,
    imageEnd,
    modelStrategy: record.project.modelStrategy,
    modelType: MODEL,
    steps: record.project.videoSteps,
    // Without this the manifest falls back to the standard preset and renders
    // at 720p, which is not what the project asked for or what H3 is held to.
    frame: {
      aspectRatio: record.project.aspectRatio,
      resolutionPreset: record.project.videoResolutionPreset ?? record.project.resolutionPreset,
    },
    durationSeconds: scene.trimAtEndSeconds ?? scene.targetDurationSeconds,
    soundscape: scene.prompts.videoSoundscape ?? scene.sfxNotes,
    score: scene.prompts.videoScore ?? scene.musicNotes,
  });

  console.log(`\n----- prompt sent [${label}] -----\n${manifest.settings.prompt}`);
  console.log(
    `\n----- other settings [${label}] -----\n` +
      `negative_prompt   : ${JSON.stringify(manifest.settings.negative_prompt)}\n` +
      `video_length      : ${manifest.settings.video_length}\n` +
      `resolution        : ${manifest.settings.resolution}\n` +
      `spatial_upsampling: ${JSON.stringify(manifest.settings.spatial_upsampling)}\n` +
      `steps             : ${manifest.settings.num_inference_steps}`,
  );

  if (!render) return;

  console.log(`\nsubmitting [${label}] to ${MODEL} …`);
  const started = Date.now();
  const job = await runToCompletion(manifest.settings);
  console.log(
    `[${label}] done in ${((Date.now() - started) / 60000).toFixed(1)} min -> ` +
      `${job.generatedFiles[0] ?? "(no file)"}`,
  );
}

function main() {
  if (process.env.H3_AB_CHILD === "1") {
    // The MCP client holds its connection open, so the child never exits on its
    // own and the parent waits forever for the second arm.
    void emit().then(
      () => process.exit(0),
      (e) => {
        console.error("FAILED:", e instanceof Error ? e.message : e);
        process.exit(1);
      },
    );
    return;
  }

  const self = fileURLToPath(import.meta.url);
  for (const enabled of ["false", "true"]) {
    console.log(`\n${"=".repeat(70)}\nH3_NATIVE_PROMPT_FORMAT=${enabled}\n${"=".repeat(70)}`);
    const result = spawnSync(process.execPath, ["--import", "tsx", self, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, H3_AB_CHILD: "1", H3_NATIVE_PROMPT_FORMAT: enabled },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

main();
