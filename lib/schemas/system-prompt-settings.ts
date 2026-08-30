import { z } from "zod";

export const MAX_SYSTEM_PROMPT_CHARACTERS = 12_000;

const promptText = z.string().max(MAX_SYSTEM_PROMPT_CHARACTERS);

/** One entry per workflow that can carry its own instructions. */
export const SYSTEM_PROMPT_SCOPE_KEYS = ["agenticCanvas", "storyboard", "renderPrompts"] as const;
export type SystemPromptScopeKey = (typeof SYSTEM_PROMPT_SCOPE_KEYS)[number];

export const ALL_SCOPES_REQUIRED =
  "Enter all three system prompts, or clear all three to use the built-in prompts.";

function requireAllOrNone(
  value: Partial<Record<SystemPromptScopeKey, string>>,
  ctx: z.RefinementCtx,
): void {
  const filled = SYSTEM_PROMPT_SCOPE_KEYS.filter((key) => Boolean(value[key]?.trim()));
  if (filled.length === 0 || filled.length === SYSTEM_PROMPT_SCOPE_KEYS.length) return;

  for (const key of SYSTEM_PROMPT_SCOPE_KEYS) {
    if (value[key]?.trim()) continue;
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: ALL_SCOPES_REQUIRED });
  }
}

/** Durable app-wide prompt policy. Absence of every value means disabled. */
export const systemPromptSettingsSchema = z
  .object({
    version: z.literal(1),
    agenticCanvas: promptText.min(1).optional(),
    storyboard: promptText.min(1).optional(),
    renderPrompts: promptText.min(1).optional(),
    updatedAt: z.string(),
  })
  .superRefine(requireAllOrNone);

export type SystemPromptSettings = z.infer<typeof systemPromptSettingsSchema>;

/** Complete editable set. Empty strings clear the custom prompt policy. */
export const updateSystemPromptSettingsSchema = z
  .object({
    agenticCanvas: promptText,
    storyboard: promptText,
    renderPrompts: promptText,
  })
  .superRefine(requireAllOrNone);

export type UpdateSystemPromptSettingsInput = z.infer<typeof updateSystemPromptSettingsSchema>;

export function emptySystemPromptSettings(): SystemPromptSettings {
  return { version: 1, updatedAt: new Date().toISOString() };
}