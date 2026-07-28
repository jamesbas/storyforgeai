import { z } from "zod";

/**
 * Reference images per character.
 *
 * Two is the ceiling of the reference-capable models in use, and matches what
 * testing showed: a second angle improved identity, a third had nowhere to go.
 */
export const MAX_REFERENCE_IMAGES = 2;

/**
 * Reusable character definitions ("the cast library").
 *
 * These live outside any single project: the whole point is that the same
 * woman, robot or mascot can be described once and reused across every story.
 * A project opts in by setting `useCharacterLibrary` and listing `characterIds`,
 * and the selected records are then threaded through the planning pipeline so
 * the Visual Bible, scene cards and image/video prompts all describe the same
 * person the same way.
 */

export const characterSchema = z.object({
  id: z.string(),
  /** How the character is referred to in scene cards and prompts. */
  name: z.string().min(1).max(80),
  /**
   * The physical description injected into prompts. Written as prompt-ready
   * prose (age, build, hair, face, skin, distinguishing features) rather than
   * as a biography — it is concatenated verbatim into image and video prompts.
   */
  description: z.string().min(1).max(2000),
  /**
   * Face-specific detail, kept apart from `description` so it can be withheld.
   *
   * A written face and a reference photo are two competing identity signals, and
   * the text wins under classifier-free guidance — measurably so: the same
   * render with these sentences removed tracked the photo far more closely.
   * Describing eyes, nose, jaw and skin here means the app can drop exactly that
   * when a photo is supplied, while `description` keeps carrying build, hair
   * length and anything a headshot cannot show.
   *
   * Leave empty when there is no reference image; then `description` should
   * carry the face as before.
   */
  facialDescription: z.string().max(1000).optional(),
  /**
   * Default outfit, used only when a project does not specify one.
   *
   * Wardrobe belongs to the story rather than the person — the same character
   * wears different clothes in different projects — so this is a fallback for
   * characters with a signature look (a uniform, a mascot costume), not the
   * primary place to set it. Projects override it per character.
   */
  wardrobe: z.string().max(500).optional(),
  /**
   * Traits to actively suppress for this character, appended to the negative
   * prompt. Comma-separated terms, e.g. "no glasses, no beard, not elderly".
   */
  negativePrompt: z.string().max(1000).optional(),
  /**
   * Stored filename of an uploaded reference image, relative to the character
   * library directory. Never a caller-supplied path: it is generated on upload
   * so a crafted value cannot escape the library root.
   *
   * @deprecated Superseded by `referenceImages`. Retained so records written
   * before multi-reference support still parse; read through
   * `referenceImagesOf()` rather than directly.
   */
  referenceImage: z.string().optional(),
  /**
   * Uploaded reference images, most representative first.
   *
   * Capped at two because that is the ceiling of the reference-capable models in
   * play, and because a second angle measurably improved identity while further
   * images had nowhere to go.
   */
  referenceImages: z.array(z.string()).max(MAX_REFERENCE_IMAGES).optional(),
  /**
   * Run a face-swap pass over generated keyframes for this character.
   *
   * Reference conditioning gets identity close but not exact; a dedicated swap
   * closes the gap. Off by default because it costs an extra render per
   * keyframe and only applies when a reference photo exists.
   */
  faceSwap: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Character = z.infer<typeof characterSchema>;

/**
 * A character's reference images, tolerating the pre-multi-image shape.
 *
 * Old records carry a single `referenceImage`; new ones carry `referenceImages`.
 * Reading through one helper keeps that migration invisible to callers.
 */
export function referenceImagesOf(character: {
  referenceImage?: string;
  referenceImages?: string[];
}): string[] {
  if (character.referenceImages?.length) return character.referenceImages.slice(0, MAX_REFERENCE_IMAGES);
  return character.referenceImage ? [character.referenceImage] : [];
}

/** Whether a face-swap pass should run for this character. */
export function wantsFaceSwap(character: {
  faceSwap?: boolean;
  referenceImage?: string;
  referenceImages?: string[];
}): boolean {
  return Boolean(character.faceSwap) && referenceImagesOf(character).length > 0;
}

export const createCharacterSchema = characterSchema.pick({
  name: true,
  description: true,
  facialDescription: true,
  wardrobe: true,
  negativePrompt: true,
  faceSwap: true,
});

export const updateCharacterSchema = createCharacterSchema.partial();

export type CreateCharacterInput = z.infer<typeof createCharacterSchema>;
export type UpdateCharacterInput = z.infer<typeof updateCharacterSchema>;

/** On-disk shape of the library file. Versioned so it can migrate later. */
export const characterLibrarySchema = z.object({
  version: z.literal(1),
  characters: z.array(characterSchema),
});

export type CharacterLibrary = z.infer<typeof characterLibrarySchema>;
