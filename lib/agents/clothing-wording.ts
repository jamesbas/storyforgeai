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
