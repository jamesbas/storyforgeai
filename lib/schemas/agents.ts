import { z } from "zod";

export const namedSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type NamedSpec = z.infer<typeof namedSpecSchema>;

export const creativeBriefSchema = z.object({
  projectId: z.string(),
  logline: z.string(),
  synopsis: z.string(),
  narrativeArc: z.object({
    beginning: z.string(),
    middle: z.string(),
    end: z.string(),
  }),
  visualStyle: z.string(),
  tone: z.string(),
  audience: z.string(),
  constraints: z.array(z.string()),
});
export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

/**
 * What the project's concept images show, read once and reused as text.
 *
 * A photograph carries palette, lighting, wardrobe and set dressing far more
 * economically than a sentence. Distilling it here means no downstream agent
 * needs a vision model, and the images are turned into tokens once rather than
 * on every one of a storyboard's calls.
 */
/** The descriptive fields a contradiction can be about. */
export const CONCEPT_VISUAL_FIELDS = [
  "setting",
  "subjects",
  "palette",
  "lighting",
  "wardrobe",
  "mood",
  "notableDetails",
  "other",
] as const;

/**
 * One place a reference image and the typed concept disagree.
 *
 * Tagged with the field it concerns rather than left as prose, because the
 * disagreement has to be actionable: the contested field is withheld from the
 * planning agents entirely. Matching a sentence against a value to work out
 * what it was about would fail quietly and in the direction of passing the
 * contested value through, which is the outcome this exists to prevent.
 */
export const conceptContradictionSchema = z
  .union([
    z.string(),
    z.object({
      field: z.enum(CONCEPT_VISUAL_FIELDS),
      /** What the typed concept says. */
      concept: z.string(),
      /** What the image shows. */
      image: z.string(),
    }),
  ])
  // Prose stored before the fields existed cannot be attributed, so it is shown
  // but scrubs nothing. Guessing a field would withhold the wrong one.
  .transform((entry) =>
    typeof entry === "string" ? { field: "other" as const, concept: "", image: entry } : entry,
  );
export type ConceptContradiction = z.infer<typeof conceptContradictionSchema>;

export const conceptVisualsSchema = z.object({
  projectId: z.string(),
  /** The place, written the way a shot description would put it. */
  setting: z.string(),
  subjects: z.array(z.string()).default([]),
  palette: z.array(z.string()).default([]),
  lighting: z.string(),
  wardrobe: z.array(z.string()).default([]),
  mood: z.string(),
  notableDetails: z.array(z.string()).default([]),
  /**
   * Where the images and the typed concept disagree. Surfaced rather than
   * resolved: a night interior against a concept that says "sunlit morning" is
   * a decision for the person who wrote both, and a model that quietly picks
   * one produces a project nobody asked for.
   */
  contradictions: z.array(conceptContradictionSchema).default([]),
  /**
   * The image filenames this reading was taken from.
   *
   * Lets the pipeline tell a current reading from one taken before the images
   * changed, without depending on clocks or on anyone remembering to re-run it.
   */
  sources: z.array(z.string()).default([]),
  /** False when no vision model was configured, so this was inferred from text. */
  fromImages: z.boolean().default(true),
});
export type ConceptVisuals = z.infer<typeof conceptVisualsSchema>;

/**
 * Where this project's finished frames departed from the concept.
 *
 * Deliberately findings and nothing else. A render is evidence of what the
 * pipeline did, not a statement of what it should do, and a description of one
 * — its palette, its wardrobe, its mood — is a description of the compromises
 * it made. Feeding that back would teach each generation the last one's
 * timidity, so this schema gives it nowhere to go but the screen.
 */
export const conceptFidelitySchema = z.object({
  projectId: z.string(),
  findings: z
    .array(
      z.object({
        /** The label the image was given in the prompt, not its position. */
        image: z.string(),
        /** What the typed concept asks for. */
        concept: z.string(),
        /** What the render actually shows. */
        shows: z.string(),
      }),
    )
    .default([]),
  /** The images that were actually looked at, in the order they were labelled. */
  images: z.array(z.string()).default([]),
  checkedAt: z.string().default(""),
});
export type ConceptFidelityReport = z.infer<typeof conceptFidelitySchema>;

export const visualBibleSchema = z.object({
  projectId: z.string(),
  artDirection: z.string(),
  colorPalette: z.array(z.string()),
  lightingRules: z.array(z.string()),
  cameraStyle: z.string(),
  characters: z.array(namedSpecSchema),
  locations: z.array(namedSpecSchema),
  props: z.array(namedSpecSchema),
  negativeRules: z.array(z.string()),
});
export type VisualBible = z.infer<typeof visualBibleSchema>;

/**
 * Story Architect artifact — narrative arc sized to the segment count. One beat
 * per 20-second segment (spec Section 9.2).
 */
export const storyPlanSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  logline: z.string(),
  emotionalProgression: z.array(z.string()),
  segmentBeats: z.array(z.string()),
});
export type StoryPlan = z.infer<typeof storyPlanSchema>;
