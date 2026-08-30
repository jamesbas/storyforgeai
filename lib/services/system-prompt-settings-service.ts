import { systemPromptSettingsStore } from "@/lib/db/system-prompt-settings-store";
import {
  systemPromptSettingsSchema,
  updateSystemPromptSettingsSchema,
  type SystemPromptSettings,
} from "@/lib/schemas/system-prompt-settings";

export async function getSystemPromptSettings(): Promise<SystemPromptSettings> {
  return systemPromptSettingsStore.get();
}

/** Replace every scope at once so a save can never leave one configured alone. */
export async function saveSystemPromptSettings(raw: unknown): Promise<SystemPromptSettings> {
  const input = updateSystemPromptSettingsSchema.parse(raw);
  const agenticCanvas = input.agenticCanvas.trim();
  const storyboard = input.storyboard.trim();
  const renderPrompts = input.renderPrompts.trim();
  const enabled = Boolean(agenticCanvas && storyboard && renderPrompts);
  const next = systemPromptSettingsSchema.parse({
    version: 1,
    ...(enabled ? { agenticCanvas, storyboard, renderPrompts } : {}),
    updatedAt: new Date().toISOString(),
  });
  return systemPromptSettingsStore.save(next);
}