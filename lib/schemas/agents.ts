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
  contradictions: z.array(z.string()).default([]),
  /** False when no vision model was configured, so this was inferred from text. */
  fromImages: z.boolean().default(true),
});
export type ConceptVisuals = z.infer<typeof conceptVisualsSchema>;

/**
 * What the project's own renders got wrong, measured against the typed concept.
 *
 * Deliberately findings and nothing else. A render is evidence of what the
 * pipeline did, not a statement of what it should do, and a description of one
 * — its palette, its wardrobe, its mood — is a description of the compromises
 * it made. Feeding that back would teach each generation the last one's
 * timidity, so this schema gives it nowhere to go but the screen.
 */
export const renderAuditSchema = z.object({
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
export type RenderAudit = z.infer<typeof renderAuditSchema>;

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
