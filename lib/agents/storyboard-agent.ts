import { z } from "zod";
import { sceneDraftSchema, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { creativeModeDirective } from "@/lib/agents/look";
import { planningPayload, precedenceDirective } from "@/lib/agents/creative-context";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { logEvent } from "@/lib/telemetry";

export const storyboardSystem = (segmentSeconds: number) =>
  `You are the Storyboard Agent. Create exactly one scene card per ${segmentSeconds}-second ` +
  "segment. Each scene must include scene objective, story beat, visual description, action, " +
  "camera movement, transition in/out, continuity notes, and optional narration/dialogue/" +
  "music/SFX notes. Scope the action to what can actually happen in " +
  `${segmentSeconds} seconds. Do not write image prompts or video prompts yet. ` +
  "Return only valid JSON.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORYBOARD_SYSTEM = storyboardSystem(SEGMENT_SECONDS);

const sceneDraftsSchema = z.object({ scenes: z.array(sceneDraftSchema) });

/**
 * Overwrite the timing fields on model-authored drafts.
 *
 * Timing is derived from the project's segmentation, but the schema exposes it,
 * and a model under structured output fills every field it is shown. One wrote
 * `trimAtEndSeconds: 2` on all three scenes of a 60-second project; that field
 * is the scene's *final* length, so each 20-second segment rendered as a
 * 2-second clip. The model owns the creative content, never the clock.
 */
function withDerivedTiming(scenes: SceneDraft[], project: Project): SceneDraft[] {
  return scenes.map((scene, index) => {
    const sceneNumber = index + 1;
    const startTimeSeconds = index * project.segmentSeconds;
    const isLast = sceneNumber === project.segmentCount;
    return {
      ...scene,
      // Identity is derived too: two scenes handed the same invented id would
      // collide in the attempts and seed maps, which are keyed by it.
      id: `${project.id}-scene-${String(sceneNumber).padStart(3, "0")}`,
      projectId: project.id,
      sceneNumber,
      startTimeSeconds,
      endTimeSeconds: startTimeSeconds + project.segmentSeconds,
      targetDurationSeconds: project.segmentSeconds,
      // Only the final scene is shortened, and only to hit the requested total.
      trimAtEndSeconds:
        isLast && project.finalTrimSeconds > 0
          ? project.segmentSeconds - project.finalTrimSeconds
          : undefined,
    };
  });
}

export async function storyboardAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<SceneDraft[]> {
  const brief = ctx.brief;
  const storyPlan = ctx.storyPlan;
  const visualBible = ctx.visualBible;
  if (!brief || !storyPlan || !visualBible) {
    throw new Error("storyboardAgent requires brief, storyPlan and visualBible in context");
  }

  if (provider) {
    const cast = ctx.cast ?? [];
    const user = JSON.stringify({
      project: ctx.project,
      brief,
      storyPlan,
      visualBible,
      cast,
      plans: planningPayload(ctx.plans),
    });
    const result = await provider.generateJson(
      storyboardSystem(ctx.project.segmentSeconds) +
        creativeModeDirective(ctx.project) +
        castSystemDirective(cast) +
        precedenceDirective(cast, ctx.plans),
      user,
      sceneDraftsSchema,
    );
    if (result && result.scenes.length === ctx.project.segmentCount) {
      return withDerivedTiming(result.scenes, ctx.project);
    }
    // Worth its own event: the deterministic drafts that follow are schema-valid
    // and look like a finished storyboard, so a silent fallback is only visible
    // as scene cards that all describe the same thing.
    logEvent("agent.fallback", {
      projectId: ctx.project.id,
      agent: "storyboard",
      reason: result ? "scene_count_mismatch" : "no_valid_response",
      expectedScenes: ctx.project.segmentCount,
      returnedScenes: result?.scenes.length ?? 0,
    });
  }
  return buildSceneDrafts(ctx.project, storyPlan, brief, visualBible, ctx.cast ?? [], ctx.plans);
}
