import { z } from "zod";
import { namedSpecSchema } from "@/lib/schemas/agents";
import { VARIANT_TYPES } from "@/lib/types";

/** Creative variant produced by the Variant Explorer Agent (spec Section 2A.4 / 9.9). */
export const creativeVariantSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  variantType: z.enum(VARIANT_TYPES),
  summary: z.string(),
  hook: z.string().optional(),
  storyAngle: z.string().optional(),
  visualStyle: z.string().optional(),
  bestFitPlatform: z.string().optional(),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  selected: z.boolean(),
  createdByAgent: z.string(),
  createdAt: z.string(),
});
export type CreativeVariant = z.infer<typeof creativeVariantSchema>;

/** World Bible (spec Section 6.3A). */
export const worldBibleSchema = z.object({
  projectId: z.string(),
  premise: z.string(),
  universeRules: z.array(z.string()),
  timelineRules: z.array(z.string()),
  locations: z.array(namedSpecSchema),
  factionsOrGroups: z.array(z.string()).optional(),
  characterRelationships: z.array(z.string()),
  recurringMotifs: z.array(z.string()),
  visualAnchors: z.array(z.string()),
  continuityConstraints: z.array(z.string()),
  forbiddenContradictions: z.array(z.string()),
});
export type WorldBible = z.infer<typeof worldBibleSchema>;

/** Directorial Plan (spec Section 6.3B). */
export const directorialPlanSchema = z.object({
  projectId: z.string(),
  creativeThesis: z.string(),
  pacingStrategy: z.string(),
  emotionalArc: z.array(z.string()),
  performanceDirection: z.array(z.string()),
  sceneIntent: z.record(z.string()),
  approvalNotes: z.array(z.string()),
});
export type DirectorialPlan = z.infer<typeof directorialPlanSchema>;

/** Cinematography Plan (spec Section 6.3C). */
export const cinematographyPlanSchema = z.object({
  projectId: z.string(),
  cameraLanguage: z.string(),
  lensAndFramingRules: z.array(z.string()),
  movementRules: z.array(z.string()),
  lightingRules: z.array(z.string()),
  sceneShotPlans: z.record(z.string()),
  transitionLanguage: z.array(z.string()),
});
export type CinematographyPlan = z.infer<typeof cinematographyPlanSchema>;

/** Art Direction Plan (spec Section 6.3D). */
export const artDirectionPlanSchema = z.object({
  projectId: z.string(),
  productionDesign: z.string(),
  wardrobeRules: z.array(z.string()),
  propRules: z.array(z.string()),
  setDressingRules: z.array(z.string()),
  typographyRules: z.array(z.string()).optional(),
  productPlacementRules: z.array(z.string()).optional(),
});
export type ArtDirectionPlan = z.infer<typeof artDirectionPlanSchema>;

/** Decision/revision history entry surfaced on the Agentic Canvas. */
export const historyEntrySchema = z.object({
  at: z.string(),
  action: z.string(),
  detail: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
