import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * Empirically confirm the wire shape of `image_refs` for IMAGE generation.
 *
 * Neither the model schema, the default settings, nor the `wangp_generate` tool
 * schema publishes a type for `image_refs` — WanGP types `source` as a bare
 * object. `multiple_references: true` implies an array of paths, but that is
 * inference. The only authoritative answer is a real submission.
 *
 * This script HAS SIDE EFFECTS: it submits generation jobs and consumes GPU
 * time. Each job is polled briefly and then cancelled.
 *
 * Usage:
 *   npx tsx scripts/wangp-refs-test.ts [modelType]
 */

const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";
const modelType = process.argv[2] ?? "qwen_image_edit_plus_20B";
const POLL_MS = 4000;
const MAX_POLLS = 12;

/** Minimal valid PNG encoder, so the probe needs no fixture asset committed. */
function writeTestPng(target: string, size = 256): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      // A recognisable gradient so a human can tell the reference was used.
      raw[offset] = Math.floor((x / size) * 255);
      raw[offset + 1] = Math.floor((y / size) * 255);
      raw[offset + 2] = 128;
      offset += 3;
    }
  }

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png);
  return target;
}

let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

async function attempt(
  client: LiveWangpClient,
  label: string,
  settings: Record<string, unknown>,
): Promise<void> {
  console.log(`\n${"=".repeat(70)}\n=== ${label}\n${"=".repeat(70)}`);
  console.log(`image_refs = ${JSON.stringify(settings.image_refs)}`);
  console.log(`video_prompt_type = ${JSON.stringify(settings.video_prompt_type)}`);

  let jobId: string;
  try {
    const job = await client.generate(settings);
    jobId = job.id;
    console.log(`SUBMIT ACCEPTED -> job ${jobId}`);
  } catch (err) {
    console.log(`SUBMIT REJECTED: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (let i = 0; i < MAX_POLLS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const job = await client.getJob(jobId);
    console.log(
      `  poll ${i + 1}: status=${job.status} progress=${job.progress}` +
        (job.errors.length ? ` errors=${JSON.stringify(job.errors)}` : "") +
        (job.generatedFiles.length ? ` files=${JSON.stringify(job.generatedFiles)}` : ""),
    );
    if (job.status === "completed") {
      console.log("  RESULT: completed — this shape is accepted end to end.");
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      console.log("  RESULT: failed — inspect errors above for the rejected field.");
      return;
    }
  }

  console.log("  still running after poll budget; cancelling to free the GPU.");
  await client.cancelJob(jobId).catch(() => undefined);
}

async function main() {
  const client = new LiveWangpClient(url);
  console.log(`probing ${url}\nmodel: ${modelType}`);

  const refPath = writeTestPng(
    path.resolve(process.cwd(), "projects", "library", "character-images", "_probe-ref.png"),
  );
  console.log(`reference image: ${refPath}`);

  const schema = await client.getModelSchema(modelType);
  const fieldNames = new Set(schema.fields.map((f) => f.name));
  console.log(`schema exposes image_refs: ${fieldNames.has("image_refs")}`);

  const base: Record<string, unknown> = {
    ...schema.defaultSettings,
    model_type: modelType,
    prompt: "A portrait of the referenced person standing in a lighthouse doorway at dusk.",
    negative_prompt: "",
    // Keep the render cheap; this is a wire-format test, not a quality test.
    num_inference_steps: 4,
  };
  if (fieldNames.has("prompt_enhancer")) base.prompt_enhancer = "";

  const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "shape";

  if (mode === "control") {
    // A path that cannot exist. If WanGP genuinely reads image_refs it must
    // fail fast; if the job is accepted and renders normally, the field is
    // being silently ignored and the whole feature is a no-op.
    await attempt(client, "CONTROL 1: non-existent reference path (expect failure)", {
      ...base,
      image_refs: [path.resolve(process.cwd(), "does-not-exist", "nope.png")],
      video_prompt_type: "I",
    });

    // Reference letter set but nothing supplied.
    await attempt(client, "CONTROL 2: video_prompt_type=I with no image_refs", {
      ...base,
      video_prompt_type: "I",
    });

    await attempt(client, "SHAPE B: single path string", {
      ...base,
      image_refs: refPath,
      video_prompt_type: "I",
    });
    return;
  }

  // "I" = "Conditional Images are People / Objects" per image_ref_choices.
  await attempt(client, "SHAPE A: array of absolute paths", {
    ...base,
    image_refs: [refPath],
    video_prompt_type: "I",
  });

  await attempt(client, "SHAPE B: single path string", {
    ...base,
    image_refs: refPath,
    video_prompt_type: "I",
  });
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
