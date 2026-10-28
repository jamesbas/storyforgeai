import { config } from "@/lib/config";
import { planningModelSettingsStore } from "@/lib/db/planning-model-settings-store";
import {
  updatePlanningModelSettingsSchema,
  type PlanningModelSettings,
  type PlanningModelSettingsView,
} from "@/lib/schemas/planning-model-settings";

function view(settings: PlanningModelSettings): PlanningModelSettingsView {
  return {
    ...settings,
    defaultModel: config.openai.model,
    effectiveModel: settings.model ?? config.openai.model,
  };
}

export async function getPlanningModelSettings(): Promise<PlanningModelSettingsView> {
  return view(await planningModelSettingsStore.get());
}

export async function getPlanningModel(): Promise<string> {
  return (await getPlanningModelSettings()).effectiveModel;
}

export async function savePlanningModelSettings(raw: unknown): Promise<PlanningModelSettingsView> {
  const input = updatePlanningModelSettingsSchema.parse(raw);
  return view(await planningModelSettingsStore.save({ version: 1, ...input }));
}
