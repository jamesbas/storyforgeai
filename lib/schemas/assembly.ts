import { z } from "zod";

export const finalCutClipSchema = z.object({
  sceneId: z.string(),
  sceneNumber: z.number().int().positive(),
  path: z.string(),
  durationSeconds: z.number().int().positive(),
  transitionIn: z.string(),
  transitionOut: z.string(),
});
export type FinalCutClip = z.infer<typeof finalCutClipSchema>;

export const finalCutPlanSchema = z.object({
  projectId: z.string(),
  clips: z.array(finalCutClipSchema),
  totalDurationSeconds: z.number().int().nonnegative(),
  finalTrimSeconds: z.number().int().nonnegative(),
});
export type FinalCutPlan = z.infer<typeof finalCutPlanSchema>;

export const assemblySchema = z.object({
  plan: finalCutPlanSchema,
  roughCutPath: z.string(),
  finalPath: z.string().optional(),
  createdAt: z.string(),
});
export type Assembly = z.infer<typeof assemblySchema>;
