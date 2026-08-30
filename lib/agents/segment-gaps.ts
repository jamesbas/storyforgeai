import { z } from "zod";

import { planEntryFor, segmentsMissingFrom } from "@/lib/agents/creative-context";
import { providerCall } from "@/lib/agents/provenance";
import { logEvent } from "@/lib/telemetry";
import type {
  PlanningProvider,
  ProviderResult,
  GenerateOptions,
} from "@/lib/agents/llm/provider";

/** A per-segment collection, and how many follow-up calls it is worth. */
export type PlanMapField = "sceneIntent" | "sceneShotPlans" | "segmentBeats";
const MAX_GAP_ROUNDS = 2;

const gapEntriesSchema = z.object({ entries: z.record(z.string()) });

/**
 * Ask again for the segments the first answer left out.
 *
 * These artifacts were one call for the whole project, and a model that stops
 * early — 18 entries for a 24-segment piece was the case that prompted this —
 * left those scenes with nothing. The shortfall was detected and reported and
 * nothing acted on it.
 *
 * Bounded on both sides: at most two extra calls, and it stops the moment a
 * round adds nothing, because a model with nothing to say for a segment will
 * say nothing however many times it is asked. The follow-up asks only for
 * `entries` rather than the whole artifact, so a second call cannot re-roll the
 * fields that were already right.
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
  },
): () => Promise<ProviderResult<T>> {
  return async () => {
    const first = await primary();
    if (!first.ok) return first;

    const map = { ...(options.read(first.value) ?? {}) };
    for (let round = 1; round <= MAX_GAP_ROUNDS; round += 1) {
      const missing = segmentsMissingFrom(map, options.segmentCount);
      if (missing.length === 0) break;

      const filled = await providerCall(
        options.provider,
        `${options.system}\n\nFOLLOW-UP. An earlier answer covered most of this piece but left ` +
          `segments ${missing.join(", ")} without an entry. Return only "entries": one line for ` +
          `each of those segment numbers, keyed by the number as a string. Write nothing for any ` +
          `other segment, and do not repeat what the earlier entries already say.`,
        JSON.stringify({
          ...options.payload,
          alreadyWritten: map,
          writeOnlyTheseSegments: missing,
        }),
        gapEntriesSchema,
        { systemPromptScope: options.systemPromptScope },
      )();
      if (!filled.ok) break;

      // Keyed by the plain number whatever the model answered with, so the next
      // round — and `segmentsMissingFrom` — agree the segment is covered.
      let added = 0;
      for (const sceneNumber of missing) {
        const entry = planEntryFor(filled.value.entries, sceneNumber);
        if (!entry) continue;
        map[String(sceneNumber)] = entry;
        added += 1;
      }
      logEvent("agent.segment_gap_filled", {
        agent: options.field,
        round,
        requested: missing.length,
        filled: added,
      });
      if (added === 0) break;
    }

    return { ...first, value: options.write(first.value, map) };
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
