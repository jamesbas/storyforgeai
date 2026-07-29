import { CREATIVE_MODE_DOCS } from "@/lib/presets";
import type { Project } from "@/lib/schemas/project";

/**
 * Turns the creative and look fields into text the models actually read.
 *
 * Both were previously carried only inside the `project` JSON handed to the
 * planning agents. A model may notice an unlabelled `"creativeMode":
 * "microdrama"` field or may not, and nothing at all guaranteed that the chosen
 * style and tone reached the render prompt — the look drifted from scene to
 * scene depending on whether the prompt agent happened to mention it. These
 * helpers state both as instructions instead of leaving them to chance.
 */

/**
 * Format conventions for the chosen creative mode, appended to the planning
 * agents' system prompts.
 *
 * Reuses the same one-line definitions the Help page shows, so what the user
 * reads and what the model is told cannot drift apart.
 */
export function creativeModeDirective(project: Project): string {
  const description = CREATIVE_MODE_DOCS[project.creativeMode];
  if (!description) return "";
  return (
    ` This piece is a ${project.creativeMode.replace(/_/g, " ")}: ${description} ` +
    "Structure, pacing and shot selection must follow that format."
  );
}

/**
 * The look, as a sentence appended to an image or video prompt.
 *
 * `existing` is the prompt it is going onto; anything already stated there is
 * dropped rather than repeated, because a doubled term in a diffusion prompt
 * carries double the weight.
 */
export function lookPromptSuffix(project: Project, existing: string): string {
  const present = existing.toLowerCase();
  const parts: string[] = [];

  const style = project.style.trim();
  const tone = project.tone.trim();
  if (style && !present.includes(style.toLowerCase())) parts.push(`${style} style`);
  if (tone && !present.includes(tone.toLowerCase())) parts.push(`${tone} mood`);

  const audience = project.audience?.trim();
  // Stated as intent rather than "framed for a <x> audience", which reads badly
  // for multi-word values and adds nothing a model can render.
  const audienceClause =
    audience && !present.includes(audience.toLowerCase())
      ? ` Intended audience: ${audience}.`
      : "";

  const look = parts.length ? ` ${parts.join(", ")}.` : "";
  return `${look}${audienceClause}`;
}
