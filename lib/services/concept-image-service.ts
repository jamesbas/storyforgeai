import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import { getProjectRecord, saveConceptImages } from "@/lib/services/project-service";

/**
 * Images that describe the project itself, rather than a character in it.
 *
 * A photograph carries palette, lighting, wardrobe and set dressing far more
 * economically than a sentence, and those are exactly the things the Visual
 * Bible and Art Director otherwise invent from one line of typed concept.
 *
 * Storage copies the character library's rules, which were written against the
 * same threats: the extension comes from the MIME type rather than the uploaded
 * name, filenames are slot-based so nothing client-supplied reaches the disk,
 * and every resolved path is checked against the folder it must stay inside.
 */

/** Upload allowlist. The extension is taken from here, never from the filename. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Enough to establish a look. Past this they stop agreeing with each other. */
export const MAX_CONCEPT_IMAGES = 6;

const DIRNAME = "concept-images";

/**
 * Ids are app-generated UUIDs. Refuse anything that could climb out of the data
 * directory before it is used to build a path.
 */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function conceptImageDir(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new ValidationError("Invalid project id");
  return path.resolve(process.cwd(), config.dataDir, projectId, DIRNAME);
}

/** Absolute path for a stored filename, or null if it escapes the folder. */
export function conceptImagePath(projectId: string, filename: string): string | null {
  const root = conceptImageDir(projectId);
  const resolved = path.resolve(root, filename);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Content type for a stored image, derived from its extension. */
export function conceptImageContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return Object.entries(IMAGE_TYPES).find(([, value]) => value === ext)?.[0] ?? "application/octet-stream";
}

export async function addConceptImage(projectId: string, file: File): Promise<string[]> {
  const record = await getProjectRecord(projectId);
  const current = record.project.conceptImages ?? [];

  const extension = IMAGE_TYPES[file.type];
  if (!extension) {
    throw new ValidationError("Concept image must be a PNG, JPEG, WebP or GIF file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ValidationError("Concept image must be 8 MB or smaller");
  }
  if (current.length >= MAX_CONCEPT_IMAGES) {
    throw new ValidationError(
      `A project can have at most ${MAX_CONCEPT_IMAGES} concept images. Remove one first.`,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new ValidationError("Concept image is empty");

  // Slot-based rather than sequential, so removing the middle image and adding
  // another cannot collide with a name still in use.
  const used = new Set(current);
  let slot = 0;
  while (used.has(`concept-${slot}${extension}`)) slot += 1;
  const filename = `concept-${slot}${extension}`;

  const target = conceptImagePath(projectId, filename);
  if (!target) throw new ValidationError("Invalid concept image filename");
  await fs.mkdir(conceptImageDir(projectId), { recursive: true });
  await fs.writeFile(target, bytes);

  const next = [...current, filename];
  await saveConceptImages(projectId, next);
  logEvent("project.concept_image_added", { id: projectId, bytes: bytes.byteLength, total: next.length });
  return next;
}

/** Remove one image, or all of them when no filename is given. */
export async function removeConceptImage(projectId: string, filename?: string): Promise<string[]> {
  const record = await getProjectRecord(projectId);
  const current = record.project.conceptImages ?? [];
  const removing = filename ? current.filter((name) => name === filename) : current;
  if (filename && removing.length === 0) throw new NotFoundError("No such concept image");

  for (const name of removing) {
    const target = conceptImagePath(projectId, name);
    if (target) await fs.rm(target, { force: true });
  }

  const next = current.filter((name) => !removing.includes(name));
  await saveConceptImages(projectId, next);
  logEvent("project.concept_image_removed", { id: projectId, removed: removing.length });
  return next;
}

/** Absolute paths of the images that are actually readable on this host. */
export async function conceptImageFiles(projectId: string): Promise<string[]> {
  const record = await getProjectRecord(projectId);
  const names = record.project.conceptImages ?? [];
  const paths: string[] = [];
  for (const name of names) {
    const resolved = conceptImagePath(projectId, name);
    if (!resolved) continue;
    if (await fs.access(resolved).then(() => true).catch(() => false)) paths.push(resolved);
  }
  return paths;
}

/**
 * Copy a project's concept images into another project's folder.
 *
 * The folder is keyed by project id, so a duplicate that merely inherits the
 * filename list points at files under someone else's directory: the thumbnails
 * 404 and the Concept Reader finds nothing, both without an error. Copying the
 * bytes is the only way the list stays true.
 *
 * Returns the names that arrived, which may be fewer than were listed if a file
 * has since been removed from disk by hand.
 */
export async function copyConceptImages(
  fromId: string,
  toId: string,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const target = conceptImageDir(toId);
  await fs.mkdir(target, { recursive: true });

  const copied: string[] = [];
  for (const name of names) {
    const source = conceptImagePath(fromId, name);
    const destination = conceptImagePath(toId, name);
    if (!source || !destination) continue;
    try {
      await fs.copyFile(source, destination);
      copied.push(name);
    } catch {
      // A missing source is not worth failing the duplicate over; the copy just
      // has one fewer reference than the original did.
    }
  }
  return copied;
}

/**
 * Remove a project's concept image folder outright.
 *
 * The uploads are written to disk whatever the persistence mode, so the
 * in-memory repository — which assumes a record is the only thing a project
 * owns — cannot clean them up. Deleting the project has to say so explicitly,
 * or the files outlive every trace of what they belonged to.
 */
export async function deleteConceptImages(projectId: string): Promise<void> {
  await fs.rm(conceptImageDir(projectId), { recursive: true, force: true }).catch(() => undefined);
}
