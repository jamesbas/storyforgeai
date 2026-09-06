import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import type { AspectRatio } from "@/lib/types";

/**
 * Storage for keyframes supplied by hand rather than rendered.
 *
 * Kept under the project's own data folder, which is already an approved media
 * root, so an imported frame streams through the ordinary media route with no
 * change to the containment policy. The bytes are always copied in: accepting a
 * path from the client would hand it the one input `path-policy` exists to
 * refuse.
 *
 * No dependency on the project record, for the same cycle-breaking reason as
 * `concept-image-files`.
 */

/** Upload allowlist. The extension comes from here, never from the filename. */
export const IMPORTED_FRAME_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export const MAX_IMPORTED_FRAME_BYTES = 16 * 1024 * 1024;

const DIRNAME = "imported-frames";

/** Ids are app-generated UUIDs; refuse anything that could climb out. */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

const ASPECT_VALUES: Record<Exclude<AspectRatio, "custom">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

/**
 * How far an imported frame's shape may sit from the project's before it is
 * cropped to fit.
 *
 * Not an exact-size check. The size a job actually renders at is snapped to
 * whatever the *resolved* model publishes, which is not known until the job is
 * built, so a 4K frame of the right shape is a perfectly good input and only
 * the proportions matter.
 *
 * Three percent is wide enough to admit the app's own presets — 1920x1088 is
 * 0.7% off true 16:9 — so a frame already the right shape is stored byte for
 * byte rather than being needlessly re-encoded.
 */
const ASPECT_TOLERANCE = 0.03;

export type ExpectedFrameShape = {
  aspectRatio: AspectRatio;
  /** The size this project nominally renders at, for reporting. */
  nominalSize: string;
};

export type ImageSize = { width: number; height: number };

export type SavedFrame = {
  path: string;
  /** Set only when the stored image differs from the file that was uploaded. */
  cropped?: { from: ImageSize; to: ImageSize };
};

/** Re-encode in the format it arrived as, so a PNG does not come back a JPEG. */
function encoded(pipeline: Sharp, extension: string): Sharp {
  if (extension === ".png") return pipeline.png();
  if (extension === ".webp") return pipeline.webp({ quality: 95 });
  return pipeline.jpeg({ quality: 95, mozjpeg: true });
}

/**
 * Centre-crop an image to the project's aspect ratio.
 *
 * Refusing a mismatch was the obvious reading of "the image is used as
 * supplied", and in practice it refused almost everything worth supplying:
 * cameras shoot 4:3 and 3:2, and image models emit squares and 832x1216. The
 * crop keeps the largest region of the right shape about the centre, so nothing
 * is scaled and the most likely subject survives.
 *
 * An image already the right shape is returned untouched — no decode, no
 * re-encode — which is what keeps the "exactly as supplied" promise true for
 * the case where it can be kept. The exception is a file carrying an EXIF
 * rotation: those bytes do not mean what they say, and downstream consumers
 * disagree about whether to honour the flag, so the rotation is baked in.
 */
async function fitToShape(
  bytes: Buffer,
  extension: string,
  expected: ExpectedFrameShape,
): Promise<{ bytes: Buffer; cropped?: { from: ImageSize; to: ImageSize } }> {
  if (expected.aspectRatio === "custom") return { bytes };

  const metadata = await sharp(bytes).metadata().catch(() => null);
  if (!metadata?.width || !metadata.height) {
    throw new ValidationError(
      "That image could not be read. It may be corrupt, or not the format its name suggests.",
    );
  }

  // Orientations 5-8 transpose the axes, so the stored width is the displayed height.
  const turned = (metadata.orientation ?? 1) >= 5;
  const from: ImageSize = {
    width: turned ? metadata.height : metadata.width,
    height: turned ? metadata.width : metadata.height,
  };

  const want = ASPECT_VALUES[expected.aspectRatio];
  const fits = Math.abs(from.width / from.height - want) / want <= ASPECT_TOLERANCE;
  if (fits && (metadata.orientation ?? 1) === 1) return { bytes };

  const to: ImageSize = fits
    ? from
    : from.width / from.height > want
      ? { width: Math.round(from.height * want), height: from.height }
      : { width: from.width, height: Math.round(from.width / want) };

  const width = Math.max(1, Math.min(to.width, from.width));
  const height = Math.max(1, Math.min(to.height, from.height));

  const out = await encoded(
    sharp(bytes)
      .rotate()
      .extract({
        left: Math.floor((from.width - width) / 2),
        top: Math.floor((from.height - height) / 2),
        width,
        height,
      }),
    extension,
  ).toBuffer();

  return {
    bytes: out,
    ...(fits ? {} : { cropped: { from, to: { width, height } } }),
  };
}

export function importedFrameDir(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new ValidationError("Invalid project id");
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), config.dataDir, projectId, DIRNAME);
}

/**
 * Copy an uploaded image in and return its absolute path.
 *
 * Named by UUID rather than after the scene: a frame outlives the attempt that
 * first pointed at it — a later import must not overwrite the image an earlier
 * attempt still references.
 */
export async function saveImportedFrame(
  projectId: string,
  file: File,
  fit?: ExpectedFrameShape,
): Promise<SavedFrame> {
  const extension = IMPORTED_FRAME_TYPES[file.type];
  if (!extension) {
    throw new ValidationError("An imported frame must be a PNG, JPEG or WebP image.");
  }
  if (file.size > MAX_IMPORTED_FRAME_BYTES) {
    throw new ValidationError("An imported frame must be 16 MB or smaller.");
  }

  const uploaded = Buffer.from(await file.arrayBuffer());
  if (uploaded.byteLength === 0) throw new ValidationError("That image file is empty.");

  const fitted = fit ? await fitToShape(uploaded, extension, fit) : { bytes: uploaded };

  const dir = importedFrameDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${randomUUID()}${extension}`);
  await fs.writeFile(target, fitted.bytes);
  return { path: target, ...(fitted.cropped ? { cropped: fitted.cropped } : {}) };
}

/** Whether a stored path points into this project's imported-frame folder. */
export function isImportedFramePath(projectId: string, candidate?: string): boolean {
  if (!candidate) return false;
  const root = importedFrameDir(projectId);
  const rel = path.relative(root, path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Remove a project's imported frames.
 *
 * `purge` already takes the whole project folder with it, but the memory store
 * has no folder to purge and the uploads are written to disk regardless of
 * persistence mode — so deletion says this explicitly rather than depending on
 * which store is configured.
 */
export async function deleteImportedFrames(projectId: string): Promise<void> {
  await fs.rm(importedFrameDir(projectId), { recursive: true, force: true }).catch(() => undefined);
}
