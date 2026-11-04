import { CREATIVE_MODE_DOCS } from "@/lib/presets";
import type { Project } from "@/lib/schemas/project";
import type { ModelFamily } from "@/lib/wangp/family";
import { isExplicitAudience } from "@/lib/agents/explicitness";
import { splitSentences } from "@/lib/agents/media-prompt-spec";

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
 *
 * Krea 2 is asked to describe a visible result, and an audience is not one, so
 * the clause is left off there — except for an explicit-content audience,
 * whose wording measurably changes what gets drawn (see `unstatedWardrobe`).
 */
export function lookPromptSuffix(project: Project, existing: string, family?: ModelFamily): string {
  const present = existing.toLowerCase();
  const parts: string[] = [];

  const style = project.style.trim();
  const tone = project.tone.trim();
  if (style && !present.includes(style.toLowerCase())) parts.push(`${style} style`);
  if (tone && !present.includes(tone.toLowerCase())) parts.push(`${tone} mood`);

  const audience = project.audience?.trim();
  const statesAudience = family !== "krea" || isExplicitAudience(audience);
  // Stated as intent rather than "framed for a <x> audience", which reads badly
  // for multi-word values and adds nothing a model can render.
  const audienceClause =
    audience && statesAudience && !present.includes(audience.toLowerCase())
      ? ` Intended audience: ${audience}.`
      : "";

  const look = parts.length ? ` ${parts.join(", ")}.` : "";
  return `${look}${audienceClause}`;
}

/**
 * Put the look where the family reads it.
 *
 * Everywhere else it trails the prompt. Krea 2's own guidance leads with the
 * medium and keeps essential requirements early, and the trailing position put
 * a project's style behind the cast sheet — so on Krea it follows the framing
 * sentence instead, ahead of the people.
 */
export function placeLook(prompt: string, look: string, family?: ModelFamily): string {
  if (!look.trim()) return prompt;
  if (family !== "krea") return `${prompt}${look}`;
  const [first, ...rest] = splitSentences(prompt);
  const at = first && rest.length ? prompt.indexOf(first) : -1;
  if (at < 0) return `${prompt}${look}`;
  const end = at + first!.length;
  return `${prompt.slice(0, end)} ${look.trim()}${prompt.slice(end)}`;
}
