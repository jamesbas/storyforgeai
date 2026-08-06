import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";

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
export async function saveImportedFrame(projectId: string, file: File): Promise<string> {
  const extension = IMPORTED_FRAME_TYPES[file.type];
  if (!extension) {
    throw new ValidationError("An imported frame must be a PNG, JPEG or WebP image.");
  }
  if (file.size > MAX_IMPORTED_FRAME_BYTES) {
    throw new ValidationError("An imported frame must be 16 MB or smaller.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new ValidationError("That image file is empty.");

  const dir = importedFrameDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${randomUUID()}${extension}`);
  await fs.writeFile(target, bytes);
  return target;
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
