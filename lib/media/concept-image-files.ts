import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import type { ConceptImage, ConceptImageKind } from "@/lib/schemas/project";

/**
 * Concept-image file operations, with no dependency on the project record.
 *
 * Split out of `concept-image-service` to break a cycle: that module needs
 * `project-service` for `getProjectRecord`, and `project-service` needs these
 * helpers back. The cycle forced five `await import()` calls, and a dynamic
 * import of a module inside a cycle is exactly what failed to resolve its chunk
 * in a production Turbopack build.
 *
 * Everything here takes ids and entries, so it can be imported statically from
 * either side.
 */

/** Upload allowlist. The extension is taken from here, never from the filename. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Enough to establish a look. Past this they stop agreeing with each other. */
export const MAX_CONCEPT_IMAGES = 6;

const DIRNAME = "concept-images";

/**
 * Ids are app-generated UUIDs. Refuse anything that could climb out of the data
 * directory before it is used to build a path.
 */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

export function conceptImageDir(projectId: string): string {
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
  return (
    Object.entries(IMAGE_TYPES).find(([, value]) => value === ext)?.[0] ??
    "application/octet-stream"
  );
}

export type ConceptImageFile = ConceptImage & { path: string };

/**
 * The images of one kind that are actually readable on this host.
 *
 * The kind is required rather than optional: the two kinds are read by
 * different agents for opposite purposes, and a caller that forgot to filter
 * would hand a render to the agent whose output informs the pipeline.
 */
export async function resolveConceptImageFiles(
  projectId: string,
  entries: readonly ConceptImage[],
  kind: ConceptImageKind,
): Promise<ConceptImageFile[]> {
  const files: ConceptImageFile[] = [];
  for (const entry of entries.filter((candidate) => candidate.kind === kind)) {
    const resolved = conceptImagePath(projectId, entry.name);
    if (!resolved) continue;
    if (await fs.access(resolved).then(() => true).catch(() => false)) {
      files.push({ ...entry, path: resolved });
    }
  }
  return files;
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
  entries: readonly ConceptImage[],
): Promise<ConceptImage[]> {
  if (entries.length === 0) return [];
  const target = conceptImageDir(toId);
  await fs.mkdir(target, { recursive: true });

  const copied: ConceptImage[] = [];
  for (const entry of entries) {
    const source = conceptImagePath(fromId, entry.name);
    const destination = conceptImagePath(toId, entry.name);
    if (!source || !destination) continue;
    try {
      await fs.copyFile(source, destination);
      copied.push(entry);
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
 * repository — which assumes a record is the only thing a project owns —
 * cannot clean them up. Deleting the project has to say so explicitly, or the
 * files outlive every trace of what they belonged to.
 */
export async function deleteConceptImages(projectId: string): Promise<void> {
  await fs.rm(conceptImageDir(projectId), { recursive: true, force: true }).catch(() => undefined);
}
