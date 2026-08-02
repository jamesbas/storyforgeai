import { conceptFidelitySchema, type ConceptFidelityReport } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { visionAvailable } from "@/lib/agents/llm/provider";
import { loadImagesAsDataUrls } from "@/lib/media/data-url";
import { logEvent } from "@/lib/telemetry";

/**
 * Compares finished frames against the concept that was originally typed.
 *
 * Not a second QC agent. QC grades a render against its scene card, which makes
 * it blind to the failure that matters most here: a scene card that already
 * lost what the concept asked for. A card written without the men in shot,
 * rendered faithfully, passes QC — correctly, because the render matches the
 * card. Only the concept still holds the original intent, and nothing else in
 * the pipeline ever looks back at it.
 *
 * It is also the only check that sees frames from different scenes at once, so
 * it can notice that one has four men and another three. Per-scene QC cannot,
 * however good the model is: the two frames are never in the same call.
 *
 * The counterpart to the Concept Reader, and deliberately not the same agent.
 * The Reader describes references so the pipeline can aim at them; this one
 * describes nothing at all. It answers one question per image — does this match
 * what was written? — and the answer goes to the screen.
 *
 * The separation is the point. A render's palette, wardrobe and mood record
 * what the pipeline settled for, not what was asked for: a scene written as
 * explicit and rendered as coy reads back as "intimate". Route that into the
 * Art Director and every generation starts from the last one's retreat, each
 * step small enough to look reasonable. `conceptFidelitySchema` therefore has
 * no descriptive fields to route.
 */

export const CONCEPT_FIDELITY_SYSTEM =
  "You are the Concept Fidelity Check. The attached images are frames this pipeline generated " +
  "for the project described in the user message, labelled there in the order they are attached. " +
  "Your only job is to find where a frame fails to deliver what the concept asked for. " +
  "Go through the concept detail by detail — who should be present and how many, what they " +
  "should be wearing, where it happens, what is on the set, how explicit it should be — and " +
  "compare each against the frames. Compare the frames with each other too, and report anything " +
  "that cannot be true of the same scene. " +
  "Report a finding only when a frame plainly departs from the concept. For each one give the " +
  "image label, what the concept asks for, and what the frame actually shows. " +
  "Do not soften a finding and do not give the frame the benefit of the doubt: reporting a scene " +
  "as acceptable when it is not is the failure this exists to catch. " +
  "Do not suggest fixes, do not praise what worked, and do not describe frames that match. " +
  "Return an empty findings array when the frames deliver the concept. Return only valid JSON.";

/**
 * Check the supplied frames against the concept.
 *
 * Returns an empty report rather than throwing when there is no vision model or
 * no readable image: a report that found nothing because it looked at nothing
 * must not read as a report that found nothing wrong, which is why `images`
 * records what was actually examined.
 */
export async function conceptFidelityAgent(
  project: Project,
  imagePaths: readonly string[],
  provider: PlanningProvider | null,
): Promise<ConceptFidelityReport> {
  const checkedAt = new Date().toISOString();
  const empty: ConceptFidelityReport = { projectId: project.id, findings: [], images: [], checkedAt };
  if (!provider || !visionAvailable()) return empty;

  const loaded = await loadImagesAsDataUrls(imagePaths, "concept_fidelity");
  if (loaded.length === 0) return empty;

  const labels = loaded.map((_, index) => `Image ${index + 1}`);
  logEvent("project.concept_fidelity", {
    projectId: project.id,
    supplied: imagePaths.length,
    images: loaded.length,
  });

  const user = JSON.stringify({
    project: {
      concept: project.concept,
      style: project.style,
      tone: project.tone,
      creativeMode: project.creativeMode,
    },
    images: labels,
  });

  const result = await provider.generateJson(CONCEPT_FIDELITY_SYSTEM, user, conceptFidelitySchema, {
    images: loaded.map((image) => image.url),
  });

  if (!result) {
    logEvent("agent.fallback", {
      projectId: project.id,
      agent: "concept_fidelity",
      reason: "no_valid_response",
    });
    return empty;
  }
  // Stamped from our side, as elsewhere: the model is told its own id and the
  // labels, and is trusted with neither.
  return { ...result, projectId: project.id, images: labels, checkedAt };
}
