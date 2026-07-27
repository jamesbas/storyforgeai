import path from "node:path";
import fs from "node:fs";
import { getWangpClient } from "@/lib/wangp/factory";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { buildImageManifest, buildVideoManifest, runToCompletion } from "@/lib/services/wangp-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { assembleRoughCut, listMedia } from "@/lib/services/assembly-service";
import { probeMedia } from "@/lib/media/ffmpeg";
import { config } from "@/lib/config";

/**
 * Live end-to-end run against a real WanGP MCP server.
 *
 *   npx tsx scripts/live-e2e.ts [--manifest-only] [--seconds 20]
 *
 * --manifest-only prints the exact settings that would be submitted without
 * spending GPU time, which is the fast way to validate the adapter.
 */
const args = process.argv.slice(2);
const manifestOnly = args.includes("--manifest-only");
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 20;

function banner(text: string) {
  console.log(`\n${"=".repeat(64)}\n${text}\n${"=".repeat(64)}`);
}

async function main() {
  banner("1. WanGP connection");
  const client = getWangpClient();
  console.log(`mode=${client.mode} url=${config.wangp.url}`);
  console.log(`health=${await client.health()}`);
  if (client.mode !== "live") throw new Error("Not in live mode — set WANGP_MCP_ENABLED=true");

  banner("2. Model selection");
  const [images, videos] = await Promise.all([client.listModels("image"), client.listModels("video")]);
  console.log(`image models=${images.length} video models=${videos.length}`);

  banner("3. Storyboard");
  const project = await createProject({
    concept: "A lighthouse keeper watches a storm roll in over a dark sea.",
    requestedDurationSeconds: seconds,
    tone: "moody",
    style: "cinematic",
  });
  const record = await generateStoryboard(project.id);
  const scene = record.storyboard!.scenes[0]!;
  console.log(`scenes=${record.storyboard!.scenes.length}`);
  console.log(`scene 1 video prompt:\n  ${scene.prompts.videoPromptSegment}`);

  banner("4. Settings manifests (what actually goes to WanGP)");
  const startManifest = await buildImageManifest({
    sceneId: scene.id,
    purpose: "start_frame",
    prompt: scene.prompts.startFramePrompt,
    negativePrompt: scene.prompts.imageNegativePrompt,
    modelStrategy: project.modelStrategy,
  });
  console.log(`START FRAME model=${startManifest.modelType}`);
  console.log(`  ${JSON.stringify(startManifest.settings).slice(0, 400)}`);

  const videoManifest = await buildVideoManifest({
    sceneId: scene.id,
    prompt: scene.prompts.videoPromptSegment,
    negativePrompt: scene.prompts.videoNegativePrompt,
    imageStart: "PLACEHOLDER_START.png",
    imageEnd: "PLACEHOLDER_END.png",
    modelStrategy: project.modelStrategy,
    fps: config.defaults.fps,
  });
  console.log(`VIDEO model=${videoManifest.modelType}`);
  console.log(`  video_length=${videoManifest.settings.video_length}`);
  console.log(`  prompt_enhancer=${JSON.stringify(videoManifest.settings.prompt_enhancer)}`);
  console.log(`  image_prompt_type=${JSON.stringify(videoManifest.settings.image_prompt_type)}`);
  console.log(`  ${JSON.stringify(videoManifest.settings).slice(0, 500)}`);

  if (manifestOnly) {
    console.log("\n--manifest-only: stopping before generation.");
    return;
  }

  banner("5. Generate a single image (fast sanity check)");
  const t0 = Date.now();
  const imageJob = await runToCompletion(startManifest.settings);
  console.log(`status=${imageJob.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`files=${JSON.stringify(imageJob.generatedFiles)}`);
  if (imageJob.generatedFiles[0]) {
    console.log(`exists on disk=${fs.existsSync(imageJob.generatedFiles[0])}`);
  }

  banner("6. Full scene media (start + end + video)");
  const t1 = Date.now();
  const withMedia = await generateSceneMedia(project.id, scene.id);
  const attempt = withMedia.attempts![scene.id]![0]!;
  console.log(`generated in ${((Date.now() - t1) / 60000).toFixed(1)} min`);
  console.log(`start=${attempt.startImagePath}`);
  console.log(`end  =${attempt.endImagePath}`);
  console.log(`video=${attempt.videoPath}`);
  if (attempt.videoPath) {
    console.log(`video probe=${JSON.stringify(await probeMedia(attempt.videoPath))}`);
  }

  banner("7. Approve + assemble");
  await approveAttempt(project.id, scene.id, attempt.id);
  const assembled = await assembleRoughCut(project.id);
  const cut = assembled.assembly!.roughCutPath;
  console.log(`rough cut=${cut}`);
  console.log(`probe=${JSON.stringify(await probeMedia(cut))}`);

  banner("8. Media serving");
  const media = await listMedia(project.id);
  for (const m of media) {
    console.log(`  ${m.available ? "OK " : "-- "} ${m.role.padEnd(12)} ${m.url}`);
  }

  console.log(`\nProject folder: ${path.resolve(config.dataDir, project.id)}`);
}

void main().catch((e) => {
  console.error("\nE2E FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
