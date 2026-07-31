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
export const wardrobeChangeSchema = z.object({
  characterId: z.string(),
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
});

export type WardrobeChange = z.infer<typeof wardrobeChangeSchema>;

/** Change points for one scene, at most one per character. */
export const sceneWardrobeChangesSchema = z
  .array(wardrobeChangeSchema)
  .max(8)
  .superRefine((changes, ctx) => {
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.characterId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Two wardrobe changes for the same character in one scene: ${change.characterId}`,
        });
      }
      seen.add(change.characterId);
    }
  });

/** What each character wears at each end of one scene. Keyed by character id. */
export type SceneWardrobe = {
  start: Record<string, string>;
  end: Record<string, string>;
  /** Changes depicted inside this scene, so a prompt can describe the act. */
  within: WardrobeChange[];
};
