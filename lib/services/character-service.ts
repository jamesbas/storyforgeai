import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createCharacterSchema,
  updateCharacterSchema,
  referenceImagesOf,
  MAX_REFERENCE_IMAGES,
  type Character,
} from "@/lib/schemas/character";
import { characterStore } from "@/lib/db/character-store";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

/**
 * Character library service. Route handlers stay thin and delegate here, in
 * line with the rest of the service layer.
 */

/** Upload allowlist. Extensions are derived from the MIME type, never from the
 * client-supplied filename, so a `.png.exe` upload cannot land on disk. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function listCharacters(): Promise<Character[]> {
  return characterStore.list();
}

export async function getCharacter(id: string): Promise<Character> {
  const character = await characterStore.get(id);
  if (!character) throw new NotFoundError(`Character ${id} not found`);
  return character;
}

export async function createCharacter(raw: unknown): Promise<Character> {
  const input = createCharacterSchema.parse(raw);
  const now = new Date().toISOString();
  const character: Character = {
    id: randomUUID(),
    name: input.name.trim(),
    description: input.description.trim(),
    facialDescription: input.facialDescription?.trim() || undefined,
    wardrobe: input.wardrobe?.trim() || undefined,
    negativePrompt: input.negativePrompt?.trim() || undefined,
    faceSwap: input.faceSwap || undefined,
    faceSwapPrompt: input.faceSwapPrompt?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await characterStore.save(character);
  logEvent("character.created", { id: character.id, name: character.name });
  return character;
}

export async function updateCharacter(id: string, raw: unknown): Promise<Character> {
  const patch = updateCharacterSchema.parse(raw);
  const existing = await getCharacter(id);
  const updated: Character = {
    ...existing,
    name: patch.name?.trim() ?? existing.name,
    description: patch.description?.trim() ?? existing.description,
    facialDescription:
      patch.facialDescription === undefined
        ? existing.facialDescription
        : patch.facialDescription.trim() || undefined,
    wardrobe:
      patch.wardrobe === undefined ? existing.wardrobe : patch.wardrobe.trim() || undefined,
    negativePrompt:
      patch.negativePrompt === undefined
        ? existing.negativePrompt
        : patch.negativePrompt.trim() || undefined,
    faceSwap: patch.faceSwap === undefined ? existing.faceSwap : patch.faceSwap || undefined,
    faceSwapPrompt:
      patch.faceSwapPrompt === undefined
        ? existing.faceSwapPrompt
        : patch.faceSwapPrompt.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await characterStore.save(updated);
  logEvent("character.updated", { id });
  return updated;
}

export async function deleteCharacter(id: string): Promise<void> {
  const existing = await getCharacter(id);
  // Every reference image, not just the first: a character may have two, and the
  // rest would otherwise be orphaned on disk with nothing pointing at them.
  for (const filename of referenceImagesOf(existing)) {
    await characterStore.deleteReferenceImage(filename);
  }
  await characterStore.remove(id);
  logEvent("character.deleted", { id });
}

/**
 * Store a reference image for a character.
 *
 * The image is not sent to the generation backend yet — WanGP identity locking
 * is a later pass. It is kept so the library shows who a description refers to,
 * and so the reference is already in place when image conditioning lands.
 */
/**
 * Add a reference image, up to the two-image ceiling.
 *
 * Filenames are slot-based rather than derived from the upload, so a crafted
 * name can never reach the filesystem. A second angle measurably improves
 * identity; beyond two there is nowhere for it to go, since the
 * reference-capable models in use accept at most two.
 */
export async function setReferenceImage(id: string, file: File): Promise<Character> {
  const existing = await getCharacter(id);

  const extension = IMAGE_TYPES[file.type];
  if (!extension) {
    throw new ValidationError("Reference image must be a PNG, JPEG, WebP or GIF file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ValidationError("Reference image must be 8 MB or smaller");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new ValidationError("Reference image is empty");

  const current = referenceImagesOf(existing);
  if (current.length >= MAX_REFERENCE_IMAGES) {
    throw new ValidationError(
      `A character can have at most ${MAX_REFERENCE_IMAGES} reference images. Remove one first.`,
    );
  }

  // Slot 0 keeps the historical `<id>.<ext>` name so existing files stay valid.
  const slot = current.length;
  const filename = slot === 0 ? `${existing.id}${extension}` : `${existing.id}-${slot}${extension}`;
  await characterStore.writeReferenceImage(filename, bytes);

  // Re-uploading the same slot in a different format orphans the old file.
  const replaced = current.filter((name) => name !== filename);
  const updated: Character = {
    ...existing,
    referenceImage: slot === 0 ? filename : existing.referenceImage,
    referenceImages: [...replaced, filename],
    updatedAt: new Date().toISOString(),
  };
  await characterStore.save(updated);
  logEvent("character.reference_image_set", {
    id,
    bytes: bytes.byteLength,
    total: updated.referenceImages?.length ?? 0,
  });
  return updated;
}

/** Remove one reference image, or all of them when no filename is given. */
export async function clearReferenceImage(id: string, filename?: string): Promise<Character> {
  const existing = await getCharacter(id);
  const current = referenceImagesOf(existing);
  const removing = filename ? current.filter((name) => name === filename) : current;

  for (const name of removing) await characterStore.deleteReferenceImage(name);
  const remaining = current.filter((name) => !removing.includes(name));

  const updated: Character = {
    ...existing,
    referenceImage: remaining[0],
    referenceImages: remaining.length ? remaining : undefined,
    updatedAt: new Date().toISOString(),
  };
  await characterStore.save(updated);
  return updated;
}

/** Content type for a stored reference image, derived from its extension. */
export function referenceImageContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const match = Object.entries(IMAGE_TYPES).find(([, value]) => value === ext);
  return match?.[0] ?? "application/octet-stream";
}

/**
 * Resolve the cast a project opted into.
 *
 * Returns an empty array when the project has not enabled the library, so
 * callers can thread the result through unconditionally. Ids that no longer
 * exist are skipped rather than throwing: deleting a character should not break
 * regeneration of an older project.
 *
 * The project's own wardrobe wins over the library default, because costume
 * belongs to the story rather than the person.
 */
export async function resolveProjectCast(project: {
  useCharacterLibrary?: boolean;
  characterIds?: string[];
  characterWardrobe?: Record<string, string>;
}): Promise<Character[]> {
  if (!project.useCharacterLibrary) return [];
  const cast = await characterStore.getMany(project.characterIds ?? []);
  const wardrobe = project.characterWardrobe ?? {};
  return cast.map((character) => {
    const override = wardrobe[character.id]?.trim();
    return override ? { ...character, wardrobe: override } : character;
  });
}
