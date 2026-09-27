import { storyPlanSchema, type StoryPlan } from "@/lib/schemas/agents";
import { maybe } from "@/lib/schemas/maybe";
import { buildStoryPlan } from "@/lib/agents/mock-agents";
import { aftermathOverrun, denouementBudget, earliestClimax } from "@/lib/agents/beat-budget";
import { repeatedBeats } from "@/lib/agents/arc-repetition";
import { creativeModeDirective } from "@/lib/agents/look";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import {
  asSegmentMap,
  withSegmentGapsFilled,
  type FollowUpExtras,
} from "@/lib/agents/segment-gaps";
import {
  SEGMENTS_PER_WINDOW,
  firstWindowDirective,
  needsWindowing,
  windowPlacementDirective,
} from "@/lib/agents/segment-windows";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { logEvent } from "@/lib/telemetry";
import { SEGMENT_SECONDS } from "@/lib/types";
import { z } from "zod";
import type { AgentContext } from "@/lib/agents/types";
import type { Project } from "@/lib/schemas/project";
import type { ExecuteOptions } from "@/lib/agents/provenance";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";

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
 * The aftermath budget as a position the climax has to reach.
 *
 * A cap on closing beats is only checkable after the fact, and a model writing
 * the opening has no way to apply it: live, a 15-segment bar fight put its
 * knockout on segment 8 — the last one the first window covered — and the seven
 * that followed were a phone call, a beer drunk twice and a receiver hung up
 * twice. Naming the segment gives the opening something to pace itself against,
 * and asking where the climax was written is what lets the code check it.
 */
function climaxDirective(segmentCount: number | undefined): string {
  if (segmentCount === undefined || segmentCount <= 2) return "";
  return (
    " The climax — the decisive event the story has been building to, after which only " +
    `aftermath remains — belongs at segment ${earliestClimax(segmentCount)} or later of ` +
    `${segmentCount}. Every segment before it is setup and build: let the setup take its time, ` +
    "and give the central action consecutive continued segments rather than finishing it early. " +
    "Report the number of the segment you wrote the climax in as climaxSegment, or null if the " +
    "climax is not among the segments you are writing in this answer."
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
  climaxDirective(segmentCount) +
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
  const opening = firstWindowDirective(
    segmentCount,
    "the title, the logline, and the beats and emotional values",
  );
  if (!needsWindowing(segmentCount)) return opening;
  const earliest = earliestClimax(segmentCount!);
  if (earliest <= SEGMENTS_PER_WINDOW) return opening;
  // "Nothing here may conclude the piece" was not enough on its own: the climax
  // still landed on the last segment this window was asked for.
  return (
    opening +
    ` The climax is at segment ${earliest} at the earliest, so it cannot happen in segments 1 to ` +
    `${SEGMENTS_PER_WINDOW}: they are the setup and the start of the build, and climaxSegment ` +
    "is null here."
  );
}

/**
 * Where a window sits, plus the two rules the arc has that the plans do not.
 *
 * The generic placement stops each window landing an ending. Where the climax
 * belongs stops a middle window spending it early, and the aftermath budget is
 * what stops the last window padding: nine consecutive reaction beats got
 * written for a film that was allowed two.
 */
function windowDirective(window: readonly number[], segmentCount: number | undefined): string {
  const placement = windowPlacementDirective(window, segmentCount);
  const last = window.at(-1) ?? 0;
  if (segmentCount === undefined) return placement;
  const earliest = earliestClimax(segmentCount);
  const climax =
    segmentCount <= 2
      ? ""
      : last < earliest
        ? ` Unless climaxSegment in the payload says it has already been written, the climax is ` +
          `at segment ${earliest} at the earliest, after this window, so these segments keep ` +
          "building towards it."
        : ` Unless climaxSegment in the payload says it has already been written, the climax ` +
          `belongs in this window, at segment ${earliest} or later.`;
  if (last < segmentCount) return placement + climax;
  return (
    placement +
    climax +
    ` At most ${denouementBudget(segmentCount)} beats in the whole film may be aftermath — ` +
    "reaction, tidying up, departure, or an empty room — so if the story is already over, the " +
    "earlier beats were written too fast and these must carry the last of the action rather than " +
    "repeat what has already happened."
  );
}

/**
 * The two arc fields that are not a line per segment, returned by every window.
 *
 * Without this a continuation had nowhere to put either: from segment 9 on, an
 * action could not span several segments however long it took, and a climax
 * written in a later window was never recorded.
 */
const arcExtras: FollowUpExtras<StoryPlan> = {
  shape: {
    continued: maybe(z.array(z.number().int())),
    climax: maybe(z.number().int()),
  },
  asks:
    ', "continued": the numbers of any of those segments that carry the previous segment\'s ' +
    'action on rather than starting a new one (an empty list if none), and "climax": the number ' +
    "of the segment among them in which you write the climax, or null if it is not among them",
  payload: (plan) => ({
    continuedSegments: plan.continuedSegments ?? [],
    climaxSegment: plan.climaxSegment ?? null,
  }),
  merge: (plan, followUp, window) => {
    const inWindow = (n: unknown): n is number =>
      typeof n === "number" && window.includes(n);
    const continued = Array.isArray(followUp.continued)
      ? followUp.continued.filter(inWindow)
      : [];
    const climax = inWindow(followUp.climax) ? followUp.climax : undefined;
    return {
      ...plan,
      ...(continued.length
        ? { continuedSegments: [...(plan.continuedSegments ?? []), ...continued] }
        : {}),
      // The first report stands: a later window claiming the climax as well is
      // restating it, and the earlier one is what decides how long the tail is.
      ...((plan.climaxSegment ?? undefined) === undefined && climax !== undefined
        ? { climaxSegment: climax }
        : {}),
    };
  },
};

/**
 * Write the arc's opening again, once, when it spent the climax early.
 *
 * Checked on the opening rather than the finished arc because that is where it
 * went wrong and where it is cheap: every window after an early climax is
 * written against a story that is already over, so finishing the arc first
 * would pay for the whole tail only to throw it away.
 *
 * The retry is kept unless it does no better. A retry reporting no climax has
 * done what it was told on a windowed arc — the climax belongs after this
 * window — and on a short one it was at least written against the correction.
 */
function withEarlyClimaxRetry(
  primary: () => Promise<ProviderResult<StoryPlan>>,
  rewrite: (feedback: string) => () => Promise<ProviderResult<StoryPlan>>,
  segmentCount: number | undefined,
): () => Promise<ProviderResult<StoryPlan>> {
  return async () => {
    const first = await primary();
    if (!first.ok) return first;
    const early = first.value.climaxSegment;
    if (early === undefined || aftermathOverrun(early, segmentCount) === 0) return first;

    const total = segmentCount!;
    const earliest = earliestClimax(total);
    logEvent("agent.arc_climax_early", { climax: early, earliest, segmentCount: total });
    const second = await rewrite(
      `\n\nREWRITE. A draft of this ${needsWindowing(total) ? "opening" : "arc"} wrote the climax ` +
        `in segment ${early}, which would leave ${total - early} of the ${total} segments for ` +
        `aftermath where at most ${denouementBudget(total)} are allowed. That time is taken from ` +
        "the story, and the end fills with reaction shots and repetition. Write it again from " +
        `segment 1 with the climax at segment ${earliest} or later: let the setup take its time, ` +
        "and give the central action several consecutive continued segments instead of finishing " +
        "it early.",
    )();
    if (!second.ok) return first;
    const later = fitClimax(second.value.climaxSegment, total);
    return later !== undefined && later <= early ? first : second;
  };
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
          withEarlyClimaxRetry(
            providerCall(provider, system, user, storyPlanSchema, {
              systemPromptScope: "storyboard",
            }),
            (feedback) =>
              providerCall(provider, system + feedback, user, storyPlanSchema, {
                systemPromptScope: "storyboard",
              }),
            ctx.project.segmentCount,
          ),
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
            extras: arcExtras,
          },
        )
      : undefined,
    // One beat per segment, even if the model returned a different count.
    validate: (plan) =>
      plan.segmentBeats.length === ctx.project.segmentCount ? undefined : "short_collection",
    fallback: () => buildStoryPlan(ctx.project),
    outcome: (plan) => arcOutcome(plan, ctx.project.segmentCount),
  });
  const { climaxSegment: reported, ...written } = value;
  const climaxSegment = fitClimax(reported, ctx.project.segmentCount);
  return {
    ...written,
    projectId: ctx.project.id,
    emotionalProgression: fitProgression(value.emotionalProgression, ctx.project),
    ...(value.continuedSegments
      ? { continuedSegments: fitContinuations(value.continuedSegments, ctx.project.segmentCount) }
      : {}),
    ...(climaxSegment !== undefined ? { climaxSegment } : {}),
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

  const overrun = aftermathOverrun(plan.climaxSegment, segmentCount);
  if (overrun > 0) {
    const climax = plan.climaxSegment!;
    issues.push(
      `climax at segment ${climax} of ${segmentCount} leaves ${segmentCount! - climax} ` +
        `aftermath beats, ${overrun} over the budget of ${denouementBudget(segmentCount!)}`,
    );
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

/** A climax only counts if it names a segment the arc actually has. */
function fitClimax(value: number | undefined, segmentCount: number): number | undefined {
  return value !== undefined && value >= 1 && value <= segmentCount ? value : undefined;
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
