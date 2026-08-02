import type { ConceptVisuals } from "@/lib/schemas/agents";

/**
 * Turning a reference reading into something a planning agent can be told.
 *
 * Two jobs, and the second is the important one. A reference image is evidence
 * of a look somebody liked; the typed concept is the brief. Where they disagree
 * the concept wins, and "wins" has to mean the contested detail never reaches
 * the agent at all.
 *
 * Annotating it is not enough. A payload carrying `wardrobe: ["black silk
 * robe"]` alongside a note saying the concept disagrees hands the model both and
 * asks it to arbitrate, which is exactly the judgement we decided it should not
 * make. So a field named in a contradiction is dropped wholesale.
 */

/** Fields the images and the concept disagree about, so cannot be trusted. */
export function contestedFields(visuals: ConceptVisuals): Set<string> {
  return new Set(visuals.contradictions.map((entry) => entry.field).filter((f) => f !== "other"));
}

/**
 * The reading with every contested field removed.
 *
 * Returns null when nothing usable survives, so callers can leave the key out
 * of their payload rather than sending an object full of empty strings — which
 * a model reads as "the reference showed nothing", not "this was withheld".
 */
export function conceptVisualsPayload(
  visuals: ConceptVisuals | undefined,
): Record<string, unknown> | null {
  if (!visuals) return null;
  const contested = contestedFields(visuals);
  const keep = <T>(field: string, value: T): T | undefined =>
    contested.has(field) ? undefined : value;

  const payload = {
    setting: keep("setting", visuals.setting || undefined),
    subjects: keep("subjects", visuals.subjects.length ? visuals.subjects : undefined),
    palette: keep("palette", visuals.palette.length ? visuals.palette : undefined),
    lighting: keep("lighting", visuals.lighting || undefined),
    wardrobe: keep("wardrobe", visuals.wardrobe.length ? visuals.wardrobe : undefined),
    mood: keep("mood", visuals.mood || undefined),
    notableDetails: keep(
      "notableDetails",
      visuals.notableDetails.length ? visuals.notableDetails : undefined,
    ),
  };

  const kept = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * What to tell an agent about the reference reading it is being given.
 *
 * Empty when there is nothing usable, so the agent is never told to consult a
 * reference that is not in its payload.
 */
export function conceptVisualsDirective(visuals: ConceptVisuals | undefined): string {
  const payload = conceptVisualsPayload(visuals);
  if (!payload || !visuals) return "";

  const contested = [...contestedFields(visuals)];
  const withheld = contested.length
    ? ` The reference disagreed with the concept about ${contested.join(", ")}, so that has been ` +
      "withheld: write those from the concept alone."
    : "";

  const source = visuals.fromImages
    ? "read from reference images the creator supplied"
    : "inferred from the typed concept, since no vision model was available";

  return (
    `\n\nREFERENCE LOOK. \`conceptVisuals\` in the payload was ${source}. Treat it as the ` +
    "creator pointing at something and saying \"like this\" — use it for texture, palette, " +
    "materials and light where the concept is silent. " +
    "It does not outrank the concept, the brief or anything pinned: where it suggests something " +
    "the concept rules out, follow the concept. Do not invent detail it does not contain, and do " +
    `not mention the reference itself in your output.${withheld}`
  );
}
