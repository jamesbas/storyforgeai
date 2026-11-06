/**
 * Clothing wording an image model draws as no clothing.
 *
 * "An open shirt that reveals his biceps" was rendered, in every frame it
 * reached, as a man with no shirt, and a patron in a clubful of clothed ones
 * became a naked one. The words describe skin, and the renderer draws the skin.
 * Nobody asking for a man in a shirt wants that, so the phrasing is replaced
 * with a plainly dressed equivalent before the description is reused by every
 * later agent.
 *
 * Deliberately narrow. It acts only on a shirt or blouse described as open or
 * unbuttoned, together with the clause that goes on to say what it reveals, and
 * on a garment worn "over a bare chest". An open jacket or an open-collared
 * shirt is ordinary clothing, a character the concept calls shirtless is
 * described as shirtless, and a description of anatomy — which an adult
 * project asks for on purpose — is never touched.
 */
const OPEN_SHIRT = /\b(an?\s+)?(?:open|opened|unbuttoned)(?:\s+|-)(?:button[- ]?(?:down|up)\s+)?(shirt|blouse)\b/i;

/**
 * Say what the body shows, not only where the garment went.
 *
 * Live, scene 1 ended with "the black lace bra hangs loose from her arms, its
 * cups gathered in her lap as she lets the fabric hang against her chest" — a
 * standing woman with no lap, and a bra described as both off and still
 * covering her. Every stage from the arc to the edit prompt copied it, nobody
 * ever wrote that she was topless, and the render drew the bra where the words
 * left it: over her chest.
 */
export const VISIBLE_RESULT_DIRECTIVE =
  " When clothing is lowered, opened, slipped off or removed, state what is now visible on the " +
  "body as well as where the garment is — 'topless, her bra hanging from one wrist', " +
  "'bare-chested, his shirt on the floor' — never only 'the bra hangs loose' or 'the shirt falls " +
  "open'. A garment that has come away no longer covers anything, so never also say it hangs " +
  "against or over the part it uncovered. Keep every garment where the pose allows it to be: " +
  "nothing rests in the lap of someone standing.";

const UPPER_GARMENT = /\b(?:bra|brassiere|bikini top|top|shirt|blouse|camisole|dress|robe|gown|nightgown|slip|corset|bodice|tank)\b/i;
const DISPLACED =
  /\b(?:loose|loosened|lowered|pulled (?:down|aside|open)|unhooked|unclasped|unfastened|unzipped|unbuttoned|undone|hanging|hangs|slipp(?:ed|ing)|falling|fallen|dropped|off (?:her|his|their|one) shoulders?|around (?:her|his|their) (?:waist|hips|elbows|wrists?|arms)|in (?:her|his|their) lap)\b/i;
const EXPOSURE = /\b(?:topless|bare|bared|naked|nude|exposed|uncovered|shirtless|breasts? (?:free|out|visible))\b/i;

/**
 * A wardrobe state that moves an upper garment without saying what is bare.
 *
 * Reported rather than rewritten: whether a lowered bra leaves her topless or
 * still half-covered is the story's decision, and guessing it either way would
 * put words in the scene it never chose.
 */
export function revealUnstated(wardrobe: string | undefined): boolean {
  if (!wardrobe?.trim()) return false;
  return UPPER_GARMENT.test(wardrobe) && DISPLACED.test(wardrobe) && !EXPOSURE.test(wardrobe);
}

export function plainClothing(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const cleaned = sentence.replace(
        /\s*,?\s*(?:over|above)\s+(?:a\s+|his\s+|her\s+|their\s+)?bare\s+chest\b/gi,
        "",
      );
      if (!OPEN_SHIRT.test(cleaned)) return cleaned;
      return cleaned
        .replace(
          new RegExp(OPEN_SHIRT.source, "gi"),
          (_whole, article: string | undefined, garment: string) =>
            `${article ? "a " : ""}buttoned ${garment}`,
        )
        .replace(/\s*,?\s*(?:that|which)\s+(?:reveal|expos|show\s+off)\w*\b[^,.;]*/gi, "")
        .replace(/\s*,?\s*(?:reveal|expos)ing\s+[^,.;]*/gi, "");
    })
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
