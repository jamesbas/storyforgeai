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
