import { z } from "zod";

export const PLANNING_MODELS = [
  "gemma4-26b-a4b-qat-uncensored-hauhaucs-balanced-mtp",
  "qwen3.5-9b-uncensored-hauhaucs-aggressive",
  "qwen3.8-9b-heretic-uncensored-nvfp4@q4_k_m",
  "qwen3.8-9b-heretic-uncensored-nvfp4@q8_0",
  "huihui-qwen3.8-27b-abliterated",
  "qwen3.8-27b-heretic-ara-16gb-vram-xs-mtp",
] as const;

export const updatePlanningModelSettingsSchema = z.object({
  model: z.enum(PLANNING_MODELS).nullable(),
}).strict();

export const planningModelSettingsSchema = updatePlanningModelSettingsSchema.extend({
  version: z.literal(1),
});

export type PlanningModelSettings = z.infer<typeof planningModelSettingsSchema>;

export type PlanningModelSettingsView = PlanningModelSettings & {
  defaultModel: string;
  effectiveModel: string;
};
