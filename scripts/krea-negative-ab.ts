import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Does Krea 2 act on a negative prompt?
 *
 * `supportsNegativePrompt("krea") === false` predates Krea 2 and is the reason
 * every Krea exclusion is folded into the positive prompt instead. The fold is
 * not free — it once put "the frame is free of twins, the same face twice" into
 * a positive prompt and got back the same woman twice — so the assumption is
 * worth an experiment rather than another round of reasoning.
 *
 * `krea2_turbo_edit` declares both `negative_prompt` and `seed`, which makes
 * this a clean test: two jobs identical in every field including the seed,
 * differing only in the negative prompt.
 *
 * **Result, 2026-08-16, `krea2_turbo_edit` at seed 12345:** the two images are
 * indistinguishable and the tomato is plainly red in both, so the field is
 * declared and discarded and `supportsNegativePrompt("krea") === false` stands.
 * The files differed by three bytes and by hash — JPEG encoding is not
 * deterministic, so bytes cannot carry the verdict and the images have to be
 * looked at.
 *
 *   npx tsx scripts/krea-negative-ab.ts
 *   npx tsx scripts/krea-negative-ab.ts --model=krea2_raw_edit --seed=99
 *
 * Deliberately built by hand rather than through `buildImageManifest`, which
 * would apply the very folding under test.
 */

const flag = (name: string, fallback: string): string =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const MODEL = flag("model", "krea2_turbo_edit");
const SEED = Number(flag("seed", "12345"));

/** A subject with one dominant, unmistakable attribute for the negative to fight. */
const PROMPT = "a studio photograph of a single ripe tomato on a plain white background, soft even light";
const NEGATIVE = "red";

function fingerprint(path: string | undefined): string {
  if (!path) return "(no file)";
  if (!existsSync(path)) return "(not reachable from here)";
  return `${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)} ${statSync(path).size}b`;
}

async function main() {
  const { runToCompletion } = await import("@/lib/services/wangp-service");

  const base = {
    model_type: MODEL,
    prompt: PROMPT,
    resolution: "1024x1024",
    num_inference_steps: 8,
    guidance_scale: 0,
    seed: SEED,
    image_mode: 1,
    batch_size: 1,
    image_prompt_type: "",
    video_prompt_type: "",
  };

  const results: { arm: string; path?: string }[] = [];
  for (const [arm, negative] of [
    ["control  (no negative)", ""],
    ["treatment (negative)  ", NEGATIVE],
  ] as const) {
    console.log(`\nsubmitting ${arm} to ${MODEL}, seed ${SEED} …`);
    const job = await runToCompletion({ ...base, negative_prompt: negative });
    const path = job.generatedFiles[0];
    console.log(`  -> ${path ?? "(no file)"}  ${fingerprint(path)}`);
    results.push({ arm, path });
  }

  const [control, treatment] = results;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`control  : ${control?.path ?? "(no file)"}`);
  console.log(`treatment: ${treatment?.path ?? "(no file)"}`);
  console.log(
    `\nOpen both. The negative asked for no "${NEGATIVE}" — if the tomato is still red,\n` +
      `the field is declared and discarded and the exclusions must keep being folded.\n` +
      `Byte and hash equality decide nothing here: JPEG encoding is not deterministic.`,
  );
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
