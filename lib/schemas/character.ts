import { z } from "zod";

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
   * Traits to actively suppress for this character, appended to the negative
   * prompt. Comma-separated terms, e.g. "no glasses, no beard, not elderly".
   */
  negativePrompt: z.string().max(1000).optional(),
  /**
   * Stored filename of an uploaded reference image, relative to the character
   * library directory. Never a caller-supplied path: it is generated on upload
   * so a crafted value cannot escape the library root.
   */
  referenceImage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Character = z.infer<typeof characterSchema>;

export const createCharacterSchema = characterSchema.pick({
  name: true,
  description: true,
  negativePrompt: true,
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
