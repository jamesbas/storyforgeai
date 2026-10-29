import { z } from "zod";

/**
 * Suggestions for the model picker, not a list of what is allowed.
 *
 * Any model id the server knows can be used, so a new release needs no change
 * here: these only seed the autocomplete alongside whatever LM Studio reports.
 */
export const PLANNING_MODELS = [
  "gemma4-26b-a4b-qat-uncensored-hauhaucs-balanced-mtp",
  "qwen3.5-9b-uncensored-hauhaucs-aggressive",
  "qwen3.8-9b-heretic-uncensored-nvfp4@q4_k_m",
  "qwen3.8-9b-heretic-uncensored-nvfp4@q8_0",
  "huihui-qwen3.8-27b-abliterated",
  "qwen3.8-27b-heretic-ara-16gb-vram-xs-mtp",
] as const;

/**
 * The stages a planning model can be chosen for.
 *
 * Named after the system-prompt scopes the agents already declare on every
 * call, so a stage needs no new plumbing at the call sites: the provider reads
 * the scope it was handed.
 */
export const PLANNING_STAGES = ["storyboard", "agentic_canvas", "render_prompts"] as const;
export type PlanningStage = (typeof PLANNING_STAGES)[number];

export const PLANNING_STAGE_LABELS: Record<PlanningStage, { title: string; detail: string }> = {
  storyboard: {
    title: "Story and storyboard",
    detail: "Reading the brief, the story arc, the visual bible and the scene cards.",
  },
  agentic_canvas: {
    title: "Creative plans",
    detail: "World bible, director, cinematographer and art direction plans.",
  },
  render_prompts: {
    title: "Prompt writing",
    detail: "Image and video prompts, and the prompt tools.",
  },
};

/**
 * A model id as the server names it.
 *
 * Free text, because the right list is whatever is installed this month. The
 * id reaches the LM Studio CLI as an argument, so it may not start with a dash
 * and cannot carry anything but the characters real ids use.
 */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@:/+-]*$/, "Not a valid model id");

const stageModelsShape = {
  storyboard: modelIdSchema.nullable(),
  agentic_canvas: modelIdSchema.nullable(),
  render_prompts: modelIdSchema.nullable(),
};

export const updatePlanningModelSettingsSchema = z.object({
  /** The model for every stage without its own. Null follows OPENAI_MODEL. */
  model: modelIdSchema.nullable(),
  /** Per-stage models. A stage left out keeps its saved value; null clears it. */
  stages: z.object(stageModelsShape).partial().strict().optional(),
}).strict();

export const planningModelSettingsSchema = z.object({
  version: z.literal(2),
  model: modelIdSchema.nullable(),
  stages: z.object(stageModelsShape).strict(),
}).strict();

/** The first release: one model for everything, chosen from six presets. */
export const legacyPlanningModelSettingsSchema = z.object({
  version: z.literal(1),
  model: modelIdSchema.nullable(),
}).strict();

export type PlanningModelSettings = z.infer<typeof planningModelSettingsSchema>;

export const EMPTY_STAGE_MODELS: PlanningModelSettings["stages"] = {
  storyboard: null,
  agentic_canvas: null,
  render_prompts: null,
};

export type PlanningModelSettingsView = PlanningModelSettings & {
  defaultModel: string;
  /** The model used for any call that names no stage. */
  effectiveModel: string;
  /** What each stage will actually use. */
  effectiveStages: Record<PlanningStage, string>;
};
