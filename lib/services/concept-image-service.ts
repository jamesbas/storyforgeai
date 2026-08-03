import fs from "node:fs/promises";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import { getProjectRecord, saveConceptImages } from "@/lib/services/project-service";
import type { ConceptImage, ConceptImageKind } from "@/lib/schemas/project";
import {
  IMAGE_TYPES,
  MAX_CONCEPT_IMAGES,
  MAX_IMAGE_BYTES,
  conceptImageDir,
  conceptImagePath,
  resolveConceptImageFiles,
  type ConceptImageFile,
} from "@/lib/media/concept-image-files";

/**
 * Images that describe the project itself, rather than a character in it.
 *
 * A photograph carries palette, lighting, wardrobe and set dressing far more
 * economically than a sentence, and those are exactly the things the Visual
 * Bible and Art Director otherwise invent from one line of typed concept.
 *
 * Every image carries the kind it was uploaded as. Filenames stay neutral so
 * that a mislabelled upload can be corrected in the record without moving bytes
 * around on disk.
 *
 * The path and byte handling lives in `lib/media/concept-image-files`, which
 * knows nothing about the project record — this module is the record-aware half.
 */

export {
  MAX_CONCEPT_IMAGES,
  conceptImagePath,
  conceptImageContentType,
  copyConceptImages,
  deleteConceptImages,
  type ConceptImageFile,
} from "@/lib/media/concept-image-files";

export async function addConceptImage(
  projectId: string,
  file: File,
  kind: ConceptImageKind,
): Promise<ConceptImage[]> {
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
  const used = new Set(current.map((entry) => entry.name));
  let slot = 0;
  while (used.has(`concept-${slot}${extension}`)) slot += 1;
  const filename = `concept-${slot}${extension}`;

  const target = conceptImagePath(projectId, filename);
  if (!target) throw new ValidationError("Invalid concept image filename");
  await fs.mkdir(conceptImageDir(projectId), { recursive: true });
  await fs.writeFile(target, bytes);

  const next: ConceptImage[] = [...current, { name: filename, kind }];
  await saveConceptImages(projectId, next);
  logEvent("project.concept_image_added", {
    id: projectId,
    kind,
    bytes: bytes.byteLength,
    total: next.length,
  });
  return next;
}

/** Remove one image, or all of them when no filename is given. */
export async function removeConceptImage(
  projectId: string,
  filename?: string,
): Promise<ConceptImage[]> {
  const record = await getProjectRecord(projectId);
  const current = record.project.conceptImages ?? [];
  const removing = filename ? current.filter((entry) => entry.name === filename) : current;
  if (filename && removing.length === 0) throw new NotFoundError("No such concept image");

  for (const entry of removing) {
    const target = conceptImagePath(projectId, entry.name);
    if (target) await fs.rm(target, { force: true });
  }

  const gone = new Set(removing.map((entry) => entry.name));
  const next = current.filter((entry) => !gone.has(entry.name));
  await saveConceptImages(projectId, next);
  logEvent("project.concept_image_removed", { id: projectId, removed: removing.length });
  return next;
}

/**
 * The images of one kind that are actually readable on this host.
 *
 * The kind is required rather than optional: the two kinds are read by
 * different agents for opposite purposes, and a caller that forgot to filter
 * would hand a render to the agent whose output informs the pipeline.
 */
export async function conceptImageFiles(
  projectId: string,
  kind: ConceptImageKind,
): Promise<ConceptImageFile[]> {
  const record = await getProjectRecord(projectId);
  return resolveConceptImageFiles(projectId, record.project.conceptImages ?? [], kind);
}
