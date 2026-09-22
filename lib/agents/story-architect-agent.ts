import { storyPlanSchema, type StoryPlan } from "@/lib/schemas/agents";
import { buildStoryPlan } from "@/lib/agents/mock-agents";
import { denouementBudget } from "@/lib/agents/beat-budget";
import { repeatedBeats } from "@/lib/agents/arc-repetition";
import { creativeModeDirective } from "@/lib/agents/look";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import {
  asSegmentMap,
  withSegmentGapsFilled,
} from "@/lib/agents/segment-gaps";
import { firstWindowDirective, windowPlacementDirective } from "@/lib/agents/segment-windows";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ExecuteOptions } from "@/lib/agents/provenance";
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

/**
 * Caps the tail, and says what to do with the segments that frees.
 *
 * "The closing beats resolve" reads as a phase to fill, so the model spends
 * whatever is left on aftermath — reaction shots, empty rooms, people leaving —
 * while the part of the story that needed the room has already been compressed
 * to fit. The budget is stated as a hard number because a proportion invites
 * rounding up.
 */
function denouementDirective(segmentCount: number | undefined): string {
  if (segmentCount === undefined || segmentCount <= 2) return "";
  const allowed = denouementBudget(segmentCount);
  return (
    ` At most ${allowed} of the final beats may be aftermath — reaction, tidying up, departure, ` +
    "or an empty room. Everything before that has to carry the story forward. If you find " +
    "yourself with segments left over and nothing left to happen, the earlier action was written " +
    "too fast: go back and give it the extra segments instead of padding the end."
  );
}

/**
 * Lets one action occupy several consecutive segments.
 *
 * Every segment is the same fixed length, and nothing downstream can lengthen
 * one, so an action that would really take a minute is written as though it
 * took twenty seconds — it starts and finishes inside a single beat, and the
 * plan reads as a sequence of things that happen instantly. The only way to
 * spend more time on something is to give it more segments, and the agent has
 * no way to know that unless it is told.
 */
function sustainedActionDirective(segmentSeconds: number): string {
  return (
    ` Not every action fits in ${segmentSeconds} seconds, and you must not compress one that does ` +
    "not. When something would realistically take longer, give it several consecutive segments " +
    "instead of squeezing it into one: write a beat for each of those segments describing that " +
    "stretch of the same continuous action — how it develops, what changes — and list the second " +
    "and later segment numbers in continuedSegments. A continued beat carries on from the one " +
    "before it in the same place with the same people; it never restarts the action, recaps it, " +
    "or jumps ahead of it. Judge the time each action honestly needs before you decide how many " +
    "segments to spend, and spend them where the story actually is."
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
  sustainedActionDirective(segmentSeconds) +
  denouementDirective(segmentCount) +
  " Give one emotional value per segment and make them move — the same value repeated across " +
  "every segment means the piece has no arc.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORY_ARCHITECT_SYSTEM = storyArchitectSystem(SEGMENT_SECONDS);

/**
 * Asks a long arc for its opening only, and says the rest is coming.
 *
 * One call for the whole plan has a ceiling, and it is lower than the projects
 * people actually make: a 27-segment piece came back with sixteen beats and
 * sixteen emotional values, the model having simply stopped.
 */
function firstPassDirective(segmentCount: number | undefined): string {
  return firstWindowDirective(
    segmentCount,
    "the title, the logline, and the beats and emotional values",
  );
}

/**
 * Where a window sits, plus the one rule the arc has that the plans do not.
 *
 * The generic placement stops each window landing an ending. The aftermath
 * budget is what stops the last window padding: nine consecutive reaction beats
 * got written for a film that was allowed two.
 */
function windowDirective(window: readonly number[], segmentCount: number | undefined): string {
  const placement = windowPlacementDirective(window, segmentCount);
  if (segmentCount === undefined || (window.at(-1) ?? 0) < segmentCount) return placement;
  return (
    placement +
    ` At most ${denouementBudget(segmentCount)} beats in the whole film may be aftermath — ` +
    "reaction, tidying up, departure, or an empty room — so if the story is already over, the " +
    "earlier beats were written too fast and these must carry the last of the action rather than " +
    "repeat what has already happened."
  );
}

export async function storyArchitectAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<StoryPlan> {
  const payload = { project: ctx.project, brief: ctx.brief };
  const user = JSON.stringify(payload);
  const base =
    storyArchitectSystem(ctx.project.segmentSeconds, ctx.project.segmentCount) +
    creativeModeDirective(ctx.project) +
    // The beats written here are what the storyboard elaborates. A beat
    // that ends at the moment it becomes explicit has already decided
    // the piece is coy, and no downstream agent can restore an event
    // that was never in the plan.
    explicitnessDirective(ctx.project, "plan");
  // The continuations inherit the arc's rules but not its opening instruction:
  // being told to write segments 1 to 8 while being asked for 17 to 24 is a
  // contradiction, and the model resolves it by renumbering.
  const system = base + firstPassDirective(ctx.project.segmentCount);

  const { value } = await executeArtifact<StoryPlan>({
    artifact: "story_plan",
    scope: "project",
    correlationId: ctx.correlationId,
    promptVersion: PROMPT_VERSIONS.storyArchitect,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: ctx.onExecution,
    // A short arc used to be discarded whole — logline, progression and every
    // beat the model did write — for a numbered template. It is the artifact
    // every later agent builds on, so that was the most expensive fallback in
    // the app: six live runs in a row recorded `deterministic/short_collection`
    // while every other canvas agent returned `llm/ok`.
    llm: provider
      ? withSegmentGapsFilled(
          providerCall(provider, system, user, storyPlanSchema, {
            systemPromptScope: "storyboard",
          }),
          {
            field: "segmentBeats",
            provider,
            system: base,
            payload,
            segmentCount: ctx.project.segmentCount,
            systemPromptScope: "storyboard",
            read: (plan) => asSegmentMap.read(plan.segmentBeats),
            write: (plan, map) => ({
              ...plan,
              segmentBeats: asSegmentMap.write(map, ctx.project.segmentCount),
            }),
            // Written with the beat it belongs to. Filled separately from the
            // deterministic template, it contradicted it.
            companion: {
              key: "emotions",
              asks: "the emotional value each of those segments plays, two or three words",
              read: (plan) => asSegmentMap.read(plan.emotionalProgression),
              write: (plan, map) => ({
                ...plan,
                emotionalProgression: asSegmentMap.write(map, ctx.project.segmentCount),
              }),
            },
            continuationDirective: windowDirective,
          },
        )
      : undefined,
    // One beat per segment, even if the model returned a different count.
    validate: (plan) =>
      plan.segmentBeats.length === ctx.project.segmentCount ? undefined : "short_collection",
    fallback: () => buildStoryPlan(ctx.project),
    outcome: (plan) => arcOutcome(plan, ctx.project.segmentCount),
  });
  return {
    ...value,
    projectId: ctx.project.id,
    emotionalProgression: fitProgression(value.emotionalProgression, ctx.project),
    ...(value.continuedSegments
      ? { continuedSegments: fitContinuations(value.continuedSegments, ctx.project.segmentCount) }
      : {}),
  };
}

/**
 * What the finished arc is worth saying about itself.
 *
 * Two things can be wrong with an arc the model did write, and both used to
 * reach the storyboard unannounced. A short emotional progression is filled
 * from the template, so the second half of a long film was directed to "rising
 * tension" over beats that had already resolved. A repeated beat is worse: it
 * is a segment of runtime spent rendering a shot the audience just watched.
 *
 * Reported rather than rejected — the rest of the arc is still the model's best
 * work, and sending it to the numbered template would lose all of it.
 */
function arcOutcome(
  plan: StoryPlan,
  segmentCount: number | undefined,
): ReturnType<NonNullable<ExecuteOptions<StoryPlan>["outcome"]>> {
  const issues: string[] = [];
  let reason: "short_collection" | "invalid_set" | undefined;

  if (!fitsSegments(plan.emotionalProgression, segmentCount)) {
    issues.push(`emotionalProgression ${plan.emotionalProgression.length} of ${segmentCount}`);
    reason = "short_collection";
  }

  const repeats = repeatedBeats(plan.segmentBeats);
  if (repeats.length) {
    issues.push(`beats ${repeats.join(", ")} repeat the beat before them`);
    reason ??= "invalid_set";
  }

  if (!issues.length) return {};
  return { source: "hybrid", fallbackReason: reason, detail: issues.join("; ") };
}

/**
 * Keep only continuations that name a real segment with something before it.
 *
 * Segment 1 has nothing to continue, and a number past the end refers to a
 * segment that will never be written. Both are cheap for a model to produce and
 * would otherwise reach the storyboard as an instruction to carry on from a
 * scene that does not exist.
 */
function fitContinuations(values: readonly number[], segmentCount: number): number[] {
  return [...new Set(values)]
    .filter((n) => n > 1 && n <= segmentCount)
    .sort((a, b) => a - b);
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
