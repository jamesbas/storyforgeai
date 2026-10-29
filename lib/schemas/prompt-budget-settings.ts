import { z } from "zod";

/** Bounds shared by the API and the settings form. */
export const PROMPT_BUDGET_LIMITS = {
  imageWords: { min: 40, max: 400 },
  wordsPerExtraPerson: { min: 0, max: 80 },
  imageMaxWords: { min: 40, max: 600 },
  videoWords: { min: 30, max: 600 },
} as const;

const bounded = (key: keyof typeof PROMPT_BUDGET_LIMITS) =>
  z.number().int().min(PROMPT_BUDGET_LIMITS[key].min).max(PROMPT_BUDGET_LIMITS[key].max);

/**
 * Word ceilings for the prompts the planner writes.
 *
 * App-wide: the right length follows the image and video models and what they
 * do with long prompts, not the story, so it is tuned once rather than per
 * project. `null` keeps the built-in per-model default.
 */
export const updatePromptBudgetSettingsSchema = z.object({
  /** One person in frame. Null uses the model's default (Qwen 140, everything else 120). */
  imageWords: bounded("imageWords").nullable(),
  /** Added to the image ceiling for each person beyond the first in a frame. */
  wordsPerExtraPerson: bounded("wordsPerExtraPerson"),
  /** The image ceiling never grows past this, however many people are in frame. */
  imageMaxWords: bounded("imageMaxWords"),
  /** Fixed clip ceiling for any segment length. Null uses the model's own formula. */
  videoWords: bounded("videoWords").nullable(),
}).strict();

export const promptBudgetSettingsSchema = updatePromptBudgetSettingsSchema.extend({
  version: z.literal(1),
});

export type PromptBudgetSettings = z.infer<typeof promptBudgetSettingsSchema>;

export const DEFAULT_PROMPT_BUDGET_SETTINGS: PromptBudgetSettings = {
  version: 1,
  imageWords: null,
  wordsPerExtraPerson: 20,
  imageMaxWords: 200,
  videoWords: null,
};
