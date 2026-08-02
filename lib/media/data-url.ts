import { readFile } from "node:fs/promises";
import path from "node:path";
import { logEvent } from "@/lib/telemetry";

/**
 * Turn image files into the data URLs a vision model accepts.
 *
 * Shared rather than duplicated: QC reads keyframes and the Concept Reader reads
 * uploaded references, and two callers should not each own a base64 encoder with
 * its own idea of the size limit.
 *
 * Skip-on-error throughout. A file this host cannot read is a missing input, not
 * a failure of whatever was going to look at it.
 */

/** Formats a vision model accepts. WanGP writes png and jpeg. */
const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * The largest image worth sending. A local vision model turns pixels into
 * tokens, and a full 1920x1088 frame can cost more prompt budget than the whole
 * scene card — for a judgement a smaller copy supports just as well.
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * A loaded image and the file it came from.
 *
 * The path travels with the URL because skipping is silent by design: a caller
 * that labelled images by their position in the input would, after one skip,
 * name every remaining image as its neighbour.
 */
export type LoadedImage = { path: string; url: string };

export async function loadImagesAsDataUrls(
  paths: readonly (string | undefined)[],
  purpose: string,
): Promise<LoadedImage[]> {
  const urls: LoadedImage[] = [];
  for (const file of paths) {
    if (!file) continue;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) {
      logEvent("image.skipped", { purpose, path: file, reason: "unsupported_format" });
      continue;
    }
    try {
      const bytes = await readFile(file);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        logEvent("image.skipped", { purpose, path: file, reason: "too_large", bytes: bytes.byteLength });
        continue;
      }
      urls.push({ path: file, url: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch {
      logEvent("image.skipped", { purpose, path: file, reason: "unreadable" });
    }
  }
  return urls;
}
