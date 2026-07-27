import fs from "node:fs";
import path from "node:path";
import { LiveWangpClient } from "@/lib/wangp/live-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { buildImageManifest, runToCompletion } from "@/lib/services/wangp-service";

/**
 * End-to-end validation of reference-image conditioning through the real
 * application code path (buildImageManifest -> WanGP), not a hand-built payload.
 *
 * HAS SIDE EFFECTS: submits a real generation and consumes GPU time.
 *
 * Usage:
 *   npx tsx scripts/wangp-refs-e2e.ts [modelType] [referenceImagePath]
 */

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";
const modelType = process.argv[2] ?? "flux2_klein_9b";
const refArg = process.argv[3];

async function main() {
  setWangpClient(new LiveWangpClient(url));
  console.log(`probing ${url}\npinned image model: ${modelType}`);

  const refPath =
    refArg ??
    fs
      .readdirSync(path.resolve(process.cwd(), "projects", "library", "character-images"))
      .map((f) => path.resolve(process.cwd(), "projects", "library", "character-images", f))
      .find((f) => /\.(png|jpe?g|webp)$/i.test(f));

  if (!refPath || !fs.existsSync(refPath)) {
    throw new Error(
      "No reference image found. Add one in Settings > Character library, or pass a path.",
    );
  }
  console.log(`reference image: ${refPath}`);

  const manifest = await buildImageManifest({
    sceneId: "e2e-scene",
    purpose: "start_frame",
    prompt:
      "Cinematic still. The referenced person stands in the doorway of a lighthouse at dusk, " +
      "storm clouds behind them. cinematic style, tense mood, cinematic lighting.",
    negativePrompt: "no watermarks, no distorted anatomy, low quality",
    modelStrategy: "auto",
    modelType,
    imageRefs: [refPath],
  });

  console.log(`\nresolved model : ${manifest.modelType}`);
  console.log(`image_refs     : ${JSON.stringify(manifest.settings.image_refs)}`);
  console.log(`video_prompt_type: ${JSON.stringify(manifest.settings.video_prompt_type)}`);

  if (manifest.settings.image_refs === undefined) {
    throw new Error("image_refs was dropped — the resolved model does not expose the field.");
  }

  console.log("\nsubmitting…");
  const job = await runToCompletion(manifest.settings);
  console.log(`status=${job.status}`);
  if (job.errors.length) console.log(`errors=${JSON.stringify(job.errors)}`);
  if (job.generatedFiles.length) console.log(`files=${JSON.stringify(job.generatedFiles)}`);
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
