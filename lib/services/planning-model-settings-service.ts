import { config } from "@/lib/config";
import { planningModelSettingsStore } from "@/lib/db/planning-model-settings-store";
import {
  PLANNING_STAGES,
  updatePlanningModelSettingsSchema,
  type PlanningModelSettings,
  type PlanningModelSettingsView,
  type PlanningStage,
} from "@/lib/schemas/planning-model-settings";

function view(settings: PlanningModelSettings): PlanningModelSettingsView {
  const effectiveModel = settings.model ?? config.openai.model;
  return {
    ...settings,
    defaultModel: config.openai.model,
    effectiveModel,
    effectiveStages: Object.fromEntries(
      PLANNING_STAGES.map((stage) => [stage, settings.stages[stage] ?? effectiveModel]),
    ) as Record<PlanningStage, string>,
  };
}

export async function getPlanningModelSettings(): Promise<PlanningModelSettingsView> {
  return view(await planningModelSettingsStore.get());
}

/**
 * The model for a call. A call that names its stage gets that stage's model if
 * one is set; everything else, including calls that name no stage, gets the
 * default.
 */
export async function getPlanningModel(stage?: PlanningStage): Promise<string> {
  const settings = await getPlanningModelSettings();
  return stage ? settings.effectiveStages[stage] : settings.effectiveModel;
}

export async function savePlanningModelSettings(raw: unknown): Promise<PlanningModelSettingsView> {
  const input = updatePlanningModelSettingsSchema.parse(raw);
  return view(
    await planningModelSettingsStore.update((current) => ({
      version: 2,
      model: input.model,
      stages: { ...current.stages, ...input.stages },
    })),
  );
}
