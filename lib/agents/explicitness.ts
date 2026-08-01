import { AUDIENCE_PRESETS, TONE_PRESETS, type PresetOption } from "@/lib/presets";
import type { Project } from "@/lib/schemas/project";

/**
 * Tells the prompt agents that the sexual content is meant to be rendered.
 *
 * Nothing did. The tone and audience presets carry descriptions saying exactly
 * that — "Explicit sexual content is intended. Nothing is softened, implied or
 * cut away from." — and those descriptions were shown in the UI and read by no
 * model. What reached the render was `lookPromptSuffix`, which staples the bare
 * values on *after* the agent has finished writing, so it cannot influence a
 * word of it. The agent was meanwhile told not to restate style or tone.
 *
 * The result was literary euphemism: "the point of contact", "drives into her".
 * A diffusion model has no representation for an implication. It renders nouns.
 */

const EXPLICIT_AUDIENCE = /explicit/i;
const EXPLICIT_TONE = /erotic|carnal|sexual/i;

function describe(presets: readonly PresetOption[], value: string): string {
  const match = presets.find((p) => p.value.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  return match?.description ?? "";
}

/** Whether this project's audience or tone asks for explicit sexual content. */
export function isExplicitProject(project: Project): boolean {
  return (
    EXPLICIT_AUDIENCE.test(project.audience ?? "") || EXPLICIT_TONE.test(project.tone ?? "")
  );
}

export function explicitnessDirective(project: Project, kind: "image" | "video"): string {
  if (!isExplicitProject(project)) return "";

  // The preset descriptions are the wording the user chose from, so the model
  // reads the same definition the settings screen showed.
  const context = [
    describe(AUDIENCE_PRESETS, project.audience ?? ""),
    describe(TONE_PRESETS, project.tone ?? ""),
  ]
    .filter(Boolean)
    .join(" ");

  const shared =
    " This project is made for adults and its sexual content is meant to be shown rather than " +
    "suggested." +
    (context ? ` ${context}` : "") +
    " Write the bodies plainly. Name the anatomy, state which parts are in contact, whose body " +
    "is where, and what is visible from this angle. Phrases like \"the point of contact\", " +
    "\"their union\" or \"he takes her\" name an idea rather than a thing, and an image model " +
    "has nothing to draw from an idea — it renders nouns. Do not soften, abstract, fade out or " +
    "cut away, and do not substitute mood words for the act itself.";

  return kind === "image"
    ? shared +
        " Describe one still frame: the position the bodies are held in at that instant, what is " +
        "seen and what is obscured, and how skin, moisture and light behave."
    : shared +
        " Spend the prompt on the movement of the act — its rhythm, direction, depth and pace, " +
        "and what each body is doing — rather than alluding to it.";
}
