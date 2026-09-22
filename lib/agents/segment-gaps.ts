import { z, type ZodType, type ZodTypeDef } from "zod";

import { planEntryFor, segmentsMissingFrom } from "@/lib/agents/creative-context";
import { providerCall } from "@/lib/agents/provenance";
import { logEvent } from "@/lib/telemetry";
import type {
  PlanningProvider,
  ProviderResult,
  GenerateOptions,
} from "@/lib/agents/llm/provider";

/** A per-segment collection that can be written a window at a time. */
export type PlanMapField = "sceneIntent" | "sceneShotPlans" | "segmentBeats";

/**
 * How many segments one follow-up may ask for.
 *
 * The whole reason a follow-up exists is that a model asked for too many
 * entries at once stops part way, so asking for the entire shortfall in a
 * single call repeats the mistake that caused it — live, a request for the
 * eleven beats missing from a 27-segment arc came back with nine of them
 * aftermath and the last two word-for-word identical. Small enough to be
 * finished, large enough that consecutive segments are written with each other
 * in view: the same reasoning, and nearly the same number, as the storyboard's
 * cards-per-call.
 */
export const SEGMENTS_PER_FOLLOW_UP = 8;

/**
 * A second entry per segment, returned by the same follow-up.
 *
 * The arc needs this and the other two maps do not: a beat and the emotional
 * value that segment plays are two halves of one decision, and filling only the
 * beats left every repaired segment with a feeling taken from the deterministic
 * template — ten consecutive "rising tension" against beats that had already
 * resolved. The storyboard slices that array per batch, so the contradiction
 * reached every scene card in the second half of the film.
 */
export type CompanionMap<T> = {
  /** The JSON key the follow-up returns it under, e.g. `emotions`. */
  key: string;
  /** What that key must contain, phrased for the prompt. */
  asks: string;
  read: (value: T) => Record<string, string> | undefined;
  write: (value: T, map: Record<string, string>) => T;
};

type FollowUp = Record<string, Record<string, string> | undefined>;

/**
 * The follow-up asks only for the segment entries, never the whole artifact, so
 * a second call cannot re-roll the fields that were already right.
 */
function followUpSchema(companionKey: string | undefined): ZodType<FollowUp, ZodTypeDef, unknown> {
  const shape: Record<string, z.ZodTypeAny> = { entries: z.record(z.string()) };
  if (companionKey) shape[companionKey] = z.record(z.string()).optional();
  return z.object(shape) as unknown as ZodType<FollowUp, ZodTypeDef, unknown>;
}

/**
 * Enough rounds to walk the whole piece in windows, plus one to discover that a
 * round has stopped adding anything.
 */
function maxRoundsFor(segmentCount: number | undefined): number {
  const windows = Math.ceil((segmentCount ?? SEGMENTS_PER_FOLLOW_UP) / SEGMENTS_PER_FOLLOW_UP);
  return Math.max(1, windows) + 1;
}

function union(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/**
 * Write the rest of a per-segment collection, a window at a time.
 *
 * These artifacts were one call for the whole project, and a model that stops
 * early — 18 entries for a 24-segment piece was the case that prompted this,
 * and 16 of 27 the case that made it windowed — left those scenes with nothing.
 * The shortfall was detected and reported and nothing acted on it.
 *
 * Bounded on both sides: a fixed number of windows, and it stops the moment a
 * round adds nothing, because a model with nothing to say for a segment will
 * say nothing however many times it is asked.
 */
export function withSegmentGapsFilled<T>(
  primary: () => Promise<ProviderResult<T>>,
  options: {
    field: PlanMapField;
    provider: PlanningProvider;
    system: string;
    payload: Record<string, unknown>;
    segmentCount: number | undefined;
    systemPromptScope?: GenerateOptions["systemPromptScope"];
    read: (value: T) => Record<string, string> | undefined;
    write: (value: T, map: Record<string, string>) => T;
    companion?: CompanionMap<T>;
    /**
     * What the caller needs said about the window being asked for. The arc uses
     * it to place the window inside the whole piece, without which the model
     * treats every window as the last one and resolves the story early.
     */
    continuationDirective?: (window: readonly number[], segmentCount: number | undefined) => string;
  },
): () => Promise<ProviderResult<T>> {
  return async () => {
    const first = await primary();
    if (!first.ok) return first;

    const { companion } = options;
    const map = { ...(options.read(first.value) ?? {}) };
    const companionMap = { ...(companion?.read(first.value) ?? {}) };
    const schema = followUpSchema(companion?.key);
    const rounds = maxRoundsFor(options.segmentCount);

    for (let round = 1; round <= rounds; round += 1) {
      const missing = segmentsMissingFrom(map, options.segmentCount);
      const missingCompanion = companion
        ? segmentsMissingFrom(companionMap, options.segmentCount)
        : [];
      const outstanding = union(missing, missingCompanion);
      if (outstanding.length === 0) break;
      const window = outstanding.slice(0, SEGMENTS_PER_FOLLOW_UP);

      const filled = await providerCall(
        options.provider,
        `${options.system}\n\nCONTINUATION. This is written a few segments at a time, and ` +
          `segments ${window.join(", ")} have not been written yet. Return only "entries": one ` +
          `line for each of those segment numbers, keyed by the number as a string` +
          (companion ? `, and "${companion.key}": ${companion.asks}, keyed the same way` : "") +
          `. Write nothing for any other segment. Carry on from what has already been written ` +
          `rather than restarting it, summarising it, or repeating what it already says.` +
          (options.continuationDirective?.(window, options.segmentCount) ?? ""),
        JSON.stringify({
          ...options.payload,
          alreadyWritten: map,
          ...(companion ? { [`alreadyWritten_${companion.key}`]: companionMap } : {}),
          writeOnlyTheseSegments: window,
        }),
        schema,
        { systemPromptScope: options.systemPromptScope },
      )();
      if (!filled.ok) break;

      // Keyed by the plain number whatever the model answered with, so the next
      // round — and `segmentsMissingFrom` — agree the segment is covered.
      let added = 0;
      let addedCompanion = 0;
      for (const sceneNumber of window) {
        if (missing.includes(sceneNumber)) {
          const entry = planEntryFor(filled.value.entries, sceneNumber);
          if (entry) {
            map[String(sceneNumber)] = entry;
            added += 1;
          }
        }
        if (companion && missingCompanion.includes(sceneNumber)) {
          const entry = planEntryFor(filled.value[companion.key], sceneNumber);
          if (entry) {
            companionMap[String(sceneNumber)] = entry;
            addedCompanion += 1;
          }
        }
      }
      logEvent("agent.segment_gap_filled", {
        agent: options.field,
        round,
        requested: window.length,
        filled: added,
        ...(companion ? { [`filled_${companion.key}`]: addedCompanion } : {}),
        outstanding: outstanding.length,
      });
      if (added + addedCompanion === 0) break;
    }

    const written = options.write(first.value, map);
    return { ...first, value: companion ? companion.write(written, companionMap) : written };
  };
}

/**
 * An ordered list read as a segment-numbered map, and written back in order.
 *
 * The per-scene plans are already `Record<string, string>` keyed by segment.
 * The story arc is a plain array, so it needs the same shape put around it to
 * reuse any of this — and it is the artifact that needed it most, being the one
 * every later agent builds on.
 */
export const asSegmentMap = {
  read: (beats: readonly string[] | undefined): Record<string, string> =>
    Object.fromEntries((beats ?? []).map((beat, i) => [String(i + 1), beat])),
  write: (map: Record<string, string>, segmentCount: number | undefined): string[] => {
    const numbered = Object.entries(map)
      .map(([key, value]) => [Number(key), value] as const)
      .filter(([n]) => Number.isFinite(n) && n >= 1)
      .sort((a, b) => a[0] - b[0]);
    // Ordered by segment number rather than by insertion: a filled gap arrives
    // after the beats that follow it and would otherwise land at the end.
    const inOrder = numbered.map(([, value]) => value);
    return segmentCount ? inOrder.slice(0, segmentCount) : inOrder;
  },
};
