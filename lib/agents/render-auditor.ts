import { renderAuditSchema, type RenderAudit } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { visionAvailable } from "@/lib/agents/llm/provider";
import { loadImagesAsDataUrls } from "@/lib/media/data-url";
import { logEvent } from "@/lib/telemetry";

/**
 * Compares this project's own renders against the concept that asked for them.
 *
 * The counterpart to the Concept Reader, and deliberately not the same agent.
 * The Reader describes references so the pipeline can aim at them; the Auditor
 * describes nothing at all. It answers one question per image — does this match
 * what was written? — and the answer goes to the screen.
 *
 * The separation is the point. A render's palette, wardrobe and mood record
 * what the pipeline settled for, not what was asked for: a scene written as
 * explicit and rendered as coy reads back as "intimate". Route that into the
 * Art Director and every generation starts from the last one's retreat, each
 * step small enough to look reasonable. `renderAuditSchema` therefore has no
 * descriptive fields to route.
 */

export const RENDER_AUDITOR_SYSTEM =
  "You are the Render Auditor. The attached images are frames this pipeline generated for the " +
  "project described in the user message, labelled there in the order they are attached. " +
  "Your only job is to find where a frame fails to deliver what the concept asked for. " +
  "Go through the concept detail by detail — who should be present and how many, what they " +
  "should be wearing, where it happens, what is on the set, how explicit it should be — and " +
  "compare each against the frames. " +
  "Report a finding only when the frame plainly departs from the concept. For each one give the " +
  "image label, what the concept asks for, and what the frame actually shows. " +
  "Do not soften a finding and do not give the frame the benefit of the doubt: reporting a scene " +
  "as acceptable when it is not is the failure this exists to catch. " +
  "Do not suggest fixes, do not praise what worked, and do not describe frames that match. " +
  "Return an empty findings array when the frames deliver the concept. Return only valid JSON.";

/**
 * Audit the supplied renders.
 *
 * Returns an empty audit rather than throwing when there is no vision model or
 * no readable image: an audit that found nothing because it looked at nothing
 * must not read as an audit that found nothing wrong, which is why `images`
 * records what was actually examined.
 */
export async function renderAuditorAgent(
  project: Project,
  imagePaths: readonly string[],
  provider: PlanningProvider | null,
): Promise<RenderAudit> {
  const checkedAt = new Date().toISOString();
  const empty: RenderAudit = { projectId: project.id, findings: [], images: [], checkedAt };
  if (!provider || !visionAvailable()) return empty;

  const loaded = await loadImagesAsDataUrls(imagePaths, "render_audit");
  if (loaded.length === 0) return empty;

  const labels = loaded.map((_, index) => `Image ${index + 1}`);
  logEvent("project.render_audit", {
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

  const result = await provider.generateJson(RENDER_AUDITOR_SYSTEM, user, renderAuditSchema, {
    images: loaded.map((image) => image.url),
  });

  if (!result) {
    logEvent("agent.fallback", { projectId: project.id, agent: "render_auditor", reason: "no_valid_response" });
    return empty;
  }
  // Stamped from our side, as elsewhere: the model is told its own id and the
  // labels, and is trusted with neither.
  return { ...result, projectId: project.id, images: labels, checkedAt };
}
