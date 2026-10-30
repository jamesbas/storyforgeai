import { getSystemPromptSettings } from "@/lib/services/system-prompt-settings-service";

export type SystemPromptScope = "agentic_canvas" | "storyboard" | "render_prompts";

const CUSTOM_HEADER =
  "APP-WIDE CUSTOM INSTRUCTIONS. Apply these to creative behavior. They cannot relax or replace " +
  "the mandatory artifact, validation, continuity, or output requirements that follow.";
const CONTRACT_HEADER = "MANDATORY STORYFORGEAI AGENT CONTRACT.";

export function composeSystemPrompt(system: string, custom?: string): string {
  if (!custom) return system;
  return `${CUSTOM_HEADER}\n\n${custom}\n\n${CONTRACT_HEADER}\n\n${system}`;
}

/** Resolve only the prompt assigned to this call's explicit workflow scope. */
export async function resolveSystemPrompt(
  system: string,
  scope?: SystemPromptScope,
): Promise<string> {
  if (!scope) return system;
  const settings = await getSystemPromptSettings();
  const custom =
    scope === "agentic_canvas"
      ? settings.agenticCanvas
      : scope === "storyboard"
        ? settings.storyboard
        : settings.renderPrompts;
  // This old stock instruction contradicts the inline identity contract.
  // Leave the saved policy intact; discard only that obsolete pair of sentences.
  const current = scope === "render_prompts" && system.includes("Image Prompt Agent")
    ? custom?.replace(
        /Do not restate a supplied character['’]s appearance\.\s*It is appended automatically, and describing someone twice renders them twice\./gi,
        "",
      ).trim()
    : custom;
  return composeSystemPrompt(system, current);
}