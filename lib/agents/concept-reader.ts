import { conceptVisualsSchema, type ConceptVisuals } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { visionAvailable } from "@/lib/agents/llm/provider";
import { loadImagesAsDataUrls } from "@/lib/media/data-url";
import { logEvent } from "@/lib/telemetry";

/**
 * Reads a project's concept images once, into text the rest of the pipeline can
 * use without any of it needing a vision model.
 *
 * Sending images with a call also changes which model answers it — the provider
 * switches to `OPENAI_VISION_MODEL` whenever images are present — so confining
 * vision to a single call confines that substitution to a single call. It is
 * also the only affordable arrangement against a local server, where planning
 * calls are serialised and a full image can cost more prompt budget than the
 * artefact being written.
 */

/**
 * Two system prompts, chosen by whether images actually reached the model.
 *
 * The discipline is QC's: a prompt that says "the attached images show" when
 * nothing was attached does not produce an empty answer, it produces an
 * invented one.
 */
export const CONCEPT_READER_VISUAL_SYSTEM =
  "You are the Concept Reader. Reference images for this project are attached. Describe what " +
  "they actually show, as a cinematographer would note it down before a shoot: the setting and " +
  "its materials, who is in them and how they are dressed, the colour palette, how the place is " +
  "lit, and the details that give it its character. " +
  "Report only what is visible. Do not invent a story, do not guess at what happens next, and " +
  "do not describe anything the pictures do not contain — an accurate short answer is worth more " +
  "than a rich invented one. " +
  "Where several images disagree, describe the common ground and note the difference. " +
  "Where an image contradicts the typed concept in the user message, record it in " +
  "`contradictions` rather than choosing between them: say what the concept states and what the " +
  "image shows. Leave `contradictions` empty when they agree. " +
  "Set fromImages to true. Return only valid JSON.";

export const CONCEPT_READER_TEXT_SYSTEM =
  "You are the Concept Reader. No images are attached and you cannot see any — infer the look " +
  "from the typed concept, style and tone in the user message alone. " +
  "Say only what the words support. Leave `contradictions` empty, since there is nothing to " +
  "compare the text against, and set fromImages to false. Return only valid JSON.";

/** Deterministic reading, so the pipeline runs with no provider at all. */
export function buildConceptVisuals(project: Project): ConceptVisuals {
  return conceptVisualsSchema.parse({
    projectId: project.id,
    setting: firstSentence(project.concept),
    subjects: [],
    palette: [],
    lighting: "As described in the concept.",
    wardrobe: [],
    mood: `${project.tone} mood, ${project.style} style.`,
    notableDetails: [],
    contradictions: [],
    fromImages: false,
  });
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const stop = trimmed.indexOf(". ");
  return stop > 0 ? trimmed.slice(0, stop + 1) : trimmed.slice(0, 400);
}

/**
 * Read the supplied images, or fall back to the text.
 *
 * `imagePaths` are absolute paths on this host; unreadable ones are skipped
 * rather than failing the run. When no vision model is configured the images are
 * not loaded at all, and the text prompt is used so the answer does not claim to
 * have seen anything.
 */
export async function conceptReaderAgent(
  project: Project,
  imagePaths: readonly string[],
  provider: PlanningProvider | null,
): Promise<ConceptVisuals> {
  if (!provider) return buildConceptVisuals(project);

  const images = visionAvailable() ? await loadImagesAsDataUrls(imagePaths, "concept") : [];
  const visual = images.length > 0;

  logEvent("project.concept_visuals", {
    projectId: project.id,
    mode: visual ? "visual" : "text_only",
    supplied: imagePaths.length,
    images: images.length,
    visionModel: visionAvailable(),
  });

  const user = JSON.stringify({
    project: {
      concept: project.concept,
      style: project.style,
      tone: project.tone,
      audience: project.audience,
      creativeMode: project.creativeMode,
    },
    imagesAttached: images.length,
  });

  const result = await provider.generateJson(
    visual ? CONCEPT_READER_VISUAL_SYSTEM : CONCEPT_READER_TEXT_SYSTEM,
    user,
    conceptVisualsSchema,
    visual ? { images } : {},
  );

  if (!result) {
    logEvent("agent.fallback", { projectId: project.id, agent: "concept_reader", reason: "no_valid_response" });
    return buildConceptVisuals(project);
  }
  // The model is told its own id but never trusted with it, as elsewhere.
  return { ...result, projectId: project.id, fromImages: visual };
}
