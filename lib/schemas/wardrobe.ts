import { z } from "zod";

/**
 * A costume change at a point in the running order.
 *
 * Project wardrobe is otherwise a constant, and deliberately so: a garment left
 * unstated is reinvented on every render, so the same outfit is repeated into
 * every prompt. That makes a change of clothes inexpressible rather than merely
 * discouraged, which is wrong for any story where someone gets dressed. A
 * change point turns the constant into a timeline — the effective wardrobe for
 * a scene is the last change at or before it.
 */
export const wardrobeChangeSchema = z
  .object({
    /** A pinned cast member, when the subject is one. */
    characterId: z.string().optional(),
    /**
     * Anyone else, written the way a prompt should refer to them — "the two
     * men", "the bartender". Unnamed people have no id to key on, and without
     * this they could not have a change point at all: the identical-clothing
     * rule would hold for every scene they appear in.
     */
    subject: z.string().min(1).max(120).optional(),
    /** What they are wearing from this point on. */
    wardrobe: z.string().min(1).max(400),
    /**
     * `within` renders the change: the start frame wears the old outfit, the end
     * frame the new one, and the clip shows it happening. `between` treats the
     * change as already done when the scene opens, which no render has to depict
     * and is the safer choice — a garment caught mid-transition is something
     * video models handle badly.
     */
    mode: z.enum(["within", "between"]),
  })
  .refine((c) => Boolean(c.characterId) !== Boolean(c.subject), {
    message: "A wardrobe change names either a cast member or a subject, not both and not neither.",
  });

export type WardrobeChange = z.infer<typeof wardrobeChangeSchema>;

/** The key a change is tracked under: a cast id, or the subject text itself. */
export function wardrobeKeyOf(change: WardrobeChange): string {
  return change.characterId ?? `subject:${change.subject!.trim().toLocaleLowerCase()}`;
}

/** Change points for one scene, at most one per subject. */
export const sceneWardrobeChangesSchema = z
  .array(wardrobeChangeSchema)
  .max(8)
  .superRefine((changes, ctx) => {
    const seen = new Set<string>();
    for (const change of changes) {
      const key = wardrobeKeyOf(change);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Two wardrobe changes for the same subject in one scene: ${change.characterId ?? change.subject}`,
        });
      }
      seen.add(key);
    }
  });

/** What each character wears at each end of one scene. Keyed by character id. */
export type SceneWardrobe = {
  start: Record<string, string>;
  end: Record<string, string>;
  /**
   * Everyone who is not pinned cast, keyed by the label the prompt uses.
   *
   * Held apart from the cast because the two are delivered differently: the
   * cast sheet is appended per character, while these need their own clause.
   */
  othersStart: Record<string, string>;
  othersEnd: Record<string, string>;
  /** Changes depicted inside this scene, so a prompt can describe the act. */
  within: WardrobeChange[];
};
