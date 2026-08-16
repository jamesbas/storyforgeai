import { storyPlanSchema, type StoryPlan } from "@/lib/schemas/agents";
import { buildStoryPlan } from "@/lib/agents/mock-agents";
import { creativeModeDirective } from "@/lib/agents/look";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

/**
 * Segment length is configurable, so it is interpolated rather than baked in:
 * telling the model "20-second segments" for an 8s project produces beats with
 * far too much action for the clip that actually gets rendered.
 *
 * The count matters as much as the length. A three-beat piece and a fifteen-beat
 * piece need different shapes, and the agent previously got no shape at all —
 * only the arithmetic instruction to divide evenly, which is why beats tended to
 * read as a list of tableaux rather than a story.
 */
function structureFor(segmentCount: number | undefined): string {
  if (segmentCount === undefined) return "";
  if (segmentCount <= 2) {
    return (
      " With this few segments there is room for one movement only: establish the situation and " +
      "land a single turn. Do not attempt a full arc."
    );
  }
  if (segmentCount <= 5) {
    return (
      " Shape it as hook, turn and payoff: earn attention in the first beat, change the situation " +
      "in the middle, and pay it off in the last."
    );
  }
  return (
    " Shape it in three acts. The opening beats establish the situation and what the subject " +
    "wants; the middle escalates through complications that each cost something; the closing " +
    "beats resolve. Place a midpoint turn near the centre where the situation reverses or the " +
    "stakes change, and make that turn visible in the emotional progression."
  );
}

export const storyArchitectSystem = (segmentSeconds: number, segmentCount?: number) =>
  "You are the Story Architect Agent. Create a complete narrative plan sized to the " +
  `requested duration. The video will be generated in ${segmentSeconds}-second segments. ` +
  "Create a story arc that can be divided cleanly into the required number of segments. " +
  "Return JSON with title, logline, emotional progression, and per-segment story beat " +
  "summaries." +
  structureFor(segmentCount) +
  // The constraint the agent has no other way to know. Each beat becomes one
  // clip rendered from exactly two keyframes, so a beat that spans time or
  // places has no pair of frames that can represent it.
  ` Each beat is rendered as a single continuous ${segmentSeconds}-second shot, generated from ` +
  "one start frame and one end frame. A beat must therefore be one action, in one place, in one " +
  "unbroken span of time. Never write a beat that skips time, summarises a period, moves between " +
  "locations, or covers several events — \"over the following weeks she trains\" and \"they argue, " +
  "then later make up\" cannot be rendered. Name the subject, what they are doing, and where. " +
  "A beat marks a change rather than a description of a state: each one must leave the situation " +
  "different from how it started, and the difference must be something an audience could see. " +
  "Give one emotional value per segment and make them move — the same value repeated across " +
  "every segment means the piece has no arc.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORY_ARCHITECT_SYSTEM = storyArchitectSystem(SEGMENT_SECONDS);

export async function storyArchitectAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<StoryPlan> {
  const user = JSON.stringify({ project: ctx.project, brief: ctx.brief });

  const { value } = await executeArtifact<StoryPlan>({
    artifact: "story_plan",
    scope: "project",
    correlationId: ctx.correlationId,
    promptVersion: PROMPT_VERSIONS.storyArchitect,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: ctx.onExecution,
    llm: provider
      ? providerCall(
          provider,
          storyArchitectSystem(ctx.project.segmentSeconds, ctx.project.segmentCount) +
            creativeModeDirective(ctx.project) +
            // The beats written here are what the storyboard elaborates. A beat
            // that ends at the moment it becomes explicit has already decided
            // the piece is coy, and no downstream agent can restore an event
            // that was never in the plan.
            explicitnessDirective(ctx.project, "plan"),
          user,
          storyPlanSchema,
        )
      : undefined,
    // One beat per segment, even if the model returned a different count.
    validate: (plan) =>
      plan.segmentBeats.length === ctx.project.segmentCount ? undefined : "short_collection",
    fallback: () => buildStoryPlan(ctx.project),
    outcome: (plan) =>
      fitsSegments(plan.emotionalProgression, ctx.project.segmentCount)
        ? {}
        : {
            source: "hybrid" as const,
            fallbackReason: "short_collection" as const,
            detail: `emotionalProgression ${plan.emotionalProgression.length} of ${ctx.project.segmentCount}`,
          },
  });
  return {
    ...value,
    projectId: ctx.project.id,
    emotionalProgression: fitProgression(value.emotionalProgression, ctx.project),
  };
}

function fitsSegments(values: readonly string[], segmentCount: number | undefined): boolean {
  return segmentCount === undefined || values.length === segmentCount;
}

/**
 * One emotional value per segment.
 *
 * The schema holds beats and emotions as two independent arrays and only the
 * beats were ever counted, so a model returning four emotions for fifteen
 * segments passed. The storyboard slices this per batch, which meant every
 * batch after the first was written with no emotional direction at all and
 * nothing reported it. Extras are dropped and a shortfall is filled from the
 * deterministic arc, which at least moves.
 */
function fitProgression(values: string[], project: Project): string[] {
  const segmentCount = project.segmentCount;
  if (fitsSegments(values, segmentCount)) return values;
  if (values.length > segmentCount!) return values.slice(0, segmentCount);
  const filler = buildStoryPlan(project).emotionalProgression;
  return Array.from(
    { length: segmentCount! },
    (_, i) => values[i] ?? filler[i] ?? values.at(-1) ?? "",
  );
}
