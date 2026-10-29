import { promptBudgetSettingsStore } from "@/lib/db/prompt-budget-settings-store";
import { logEvent } from "@/lib/telemetry";
import {
  DEFAULT_PROMPT_BUDGET_SETTINGS,
  updatePromptBudgetSettingsSchema,
  type PromptBudgetSettings,
} from "@/lib/schemas/prompt-budget-settings";

export async function getPromptBudgetSettings(): Promise<PromptBudgetSettings> {
  return promptBudgetSettingsStore.get();
}

/**
 * The limits a prompt run should use.
 *
 * A damaged settings file must not stop a batch that may be hours long, so it
 * falls back to the built-in limits and says so.
 */
export async function resolvePromptBudgetSettings(): Promise<PromptBudgetSettings> {
  try {
    return await promptBudgetSettingsStore.get();
  } catch (error) {
    logEvent("prompt.budget_settings_unreadable", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { ...DEFAULT_PROMPT_BUDGET_SETTINGS };
  }
}

export async function savePromptBudgetSettings(raw: unknown): Promise<PromptBudgetSettings> {
  const input = updatePromptBudgetSettingsSchema.parse(raw);
  return promptBudgetSettingsStore.save({ version: 1, ...input });
}
