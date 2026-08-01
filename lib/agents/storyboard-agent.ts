import { z } from "zod";
import { sceneDraftSchema, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { seamDirective } from "@/lib/agents/continuity";
import { creativeModeDirective } from "@/lib/agents/look";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { planningPayload, precedenceDirective } from "@/lib/agents/creative-context";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { Project } from "@/lib/schemas/project";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { logEvent } from "@/lib/telemetry";

export const storyboardSystem = (segmentSeconds: number) =>
  "You are the Storyboard Agent. You write a set of scene cards \u2014 one card for each " +
  `${segmentSeconds}-second segment you are asked to cover, always more than one, returned ` +
  "together as an array in the order they play. " +
  // A 26B model read "create exactly one scene card per segment" as a request
  // for one card, reasoned "create the first scene card for segment 1", and
  // stopped with finish_reason=stop after a single entry. The count has to be
  // stated in the instruction; leaving it implicit in the payload is not enough.
  "Never return a single card when several segments were requested, and never stop after the " +
  "first one. " +
  "Each scene must include scene objective, story beat, visual description, action, " +
  "camera movement, transition in/out, continuity notes, and optional narration/dialogue/" +
  "music/SFX notes. Scope the action to what can actually happen in " +
  `${segmentSeconds} seconds. ` +
  // This gates the face swap and nothing else. It once said "the main
  // character's face", which a model reasonably read as false for any scene
  // that character is absent from — and then wrote the shot to match its own
  // flag, reducing a wide shot of four men to a shot of their hands.
  "Set subjectFaceVisible according to the framing you have already chosen, and never let it " +
  "change what the shot contains. It is true whenever any person's face is in frame, even " +
  "partially, and whoever they are. Set it false only when the framing itself excludes every " +
  "face: a close-up of hands or an object, a shot from behind, a silhouette, or a crop above " +
  "the neck. A scene that none of the pinned cast appear in is not a reason to set it false — " +
  "other people are still people, and a wide or medium shot of a room with people in it shows " +
  "their faces. " +
  // A wide shot whose only human content is a pair of hands is not a shot.
  "Keep the people in the shot consistent with its size: do not describe a wide or medium shot " +
  "in terms of hands or fragments alone. If the shot is wide, say who is in the room and what " +
  "they look like. " +
  // Decides who gets a description, a reference photo and a face swap. Listing
  // someone absent puts them in the picture.
  "List in charactersPresent exactly which of the supplied cast are visible in that shot, by " +
  "their cast name. Leave it empty for a shot none of them are in. Do not list a character " +
  "who is merely mentioned, referred to, or elsewhere at the time. " +
  // Undressing is a wardrobe change like any other, and the one most often left
  // undeclared: without it the appended outfit is the last thing the render
  // reads and the clothes stay on.
  "Undressing is a wardrobe change. When a scene reaches a point where someone is no longer " +
  "dressed, record it in wardrobeChanges with the new state — \"nude\" when they are wearing " +
  "nothing, or the specific remaining garments when they are partly dressed — and set " +
  "depictedOnScreen to true if the undressing itself is what the scene shows. Declare it once, " +
  "in the scene where it happens: it carries forward on its own, and the scene where they dress " +
  "again is its own change. " +
  // Costume is otherwise a constant repeated into every prompt, so a change the
  // story requires has to be declared here or it cannot happen at all.
  "Leave wardrobeChanges empty unless the story actually requires someone to change clothes " +
  "in that scene. When it does, name the character exactly as the cast names them, or describe " +
  "anyone not in the cast the way a prompt should refer to them — 'the two men', 'the " +
  "bartender' — give the complete resulting outfit as specific garments with colours and " +
  "materials, and set depictedOnScreen to true only if the act of changing is what the scene " +
  "shows. State what they are left wearing, not what was removed: 'bare-chested, in dark jeans' " +
  "rather than 'takes his shirt off'. A character who is merely somewhere else wearing " +
  "something different is not a costume change: put the change in the scene where it happens " +
  "and leave the rest alone. " +
  "Do not write image prompts or video prompts yet. " +
  "Return only valid JSON.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORYBOARD_SYSTEM = storyboardSystem(SEGMENT_SECONDS);

/**
 * Scene cards are requested in batches rather than all at once.
 *
 * Asked for eighteen cards in one response, a 26B local model returned one and
 * stopped — and the old all-or-nothing check then threw that one away too. The
 * prompt agents never had this problem because they already run per scene, so
 * the fix is to make this agent look more like them. Small enough that the
 * model finishes the batch, large enough that consecutive scenes are written
 * with each other in view.
 */
const CARDS_PER_CALL = 4;

/** Names the slice this call owns, so the model does not try to cover the rest. */
function batchDirective(from: number, to: number, total: number): string {
  return (
    ` This request covers scenes ${from} to ${to} of ${total}. Return exactly ` +
    `${to - from + 1} scene cards, in order, one per supplied segment beat, and nothing for the ` +
    "other segments. When a previous scene is supplied, continue from where it left off rather " +
    "than reintroducing the setting."
  );
}

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

  const built = () =>
    buildSceneDrafts(ctx.project, storyPlan, brief, visualBible, ctx.cast ?? [], ctx.plans);

  if (!provider) return built();

  const cast = ctx.cast ?? [];
  const wanted = ctx.project.segmentCount;
  const system =
    storyboardSystem(ctx.project.segmentSeconds) +
    creativeModeDirective(ctx.project) +
    explicitnessDirective(ctx.project, "plan") +
    seamDirective(ctx.project) +
    castSystemDirective(cast) +
    precedenceDirective(cast, ctx.plans);

  const fallbackDrafts = built();
  const scenes: SceneDraft[] = [];
  let builderFilled = 0;

  for (let start = 0; start < wanted; start += CARDS_PER_CALL) {
    const end = Math.min(start + CARDS_PER_CALL, wanted);
    const previous = scenes[start - 1];
    const user = JSON.stringify({
      project: ctx.project,
      brief,
      visualBible,
      cast,
      plans: planningPayload(ctx.plans),
      // Only this batch's beats, so the model is not tempted to cover the rest.
      segmentNumbers: Array.from({ length: end - start }, (_, i) => start + i + 1),
      segmentBeats: storyPlan.segmentBeats.slice(start, end),
      emotionalProgression: storyPlan.emotionalProgression.slice(start, end),
      previousScene: previous
        ? {
            sceneNumber: start,
            title: previous.title,
            visualDescription: previous.visualDescription,
            actionDescription: previous.actionDescription,
            cameraMovement: previous.cameraMovement,
          }
        : undefined,
    });

    const result = await provider.generateJson(system + batchDirective(start + 1, end, wanted), user, sceneDraftsSchema);
    const returned = result?.scenes ?? [];
    for (let i = 0; i < end - start; i += 1) {
      const card = returned[i];
      if (card) scenes.push(card);
      else {
        scenes.push(fallbackDrafts[start + i]!);
        builderFilled += 1;
      }
    }
    if (returned.length !== end - start) {
      logEvent("agent.fallback", {
        projectId: ctx.project.id,
        agent: "storyboard",
        reason: "batch_short",
        batch: `${start + 1}-${end}`,
        expectedScenes: end - start,
        returnedScenes: returned.length,
      });
    }
  }

  if (builderFilled === 0) return withDerivedTiming(scenes, ctx.project);

  // Carried on the context so it reaches the stored snapshot, not just the log.
  ctx.fallbacks = [
    ...(ctx.fallbacks ?? []),
    {
      agent: "Storyboard Agent",
      reason: builderFilled === wanted ? "no_valid_response" : "scene_count_short",
      detail: `${wanted - builderFilled} of ${wanted} scene cards written by the model`,
    },
  ];
  return withDerivedTiming(scenes, ctx.project);
}
