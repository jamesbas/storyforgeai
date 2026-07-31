import type { Scene } from "@/lib/schemas/storyboard";

/**
 * Whether one scene's start frame can legitimately be the previous scene's end
 * frame.
 *
 * `reuse_end_frame` is a saving worth having when the action runs continuously
 * across a segment boundary, and a defect when it does not: the next scene's
 * start-frame prompt is never rendered, so a planned cut to a different shot
 * size silently becomes a freeze on the old framing, and the video model is
 * handed a start image that contradicts its own prompt.
 */

/** Coarse shot sizes. Only whether two differ matters, not the spacing. */
export type ShotSize =
  | "extreme_wide"
  | "wide"
  | "full"
  | "medium_wide"
  | "medium"
  | "medium_close"
  | "close"
  | "extreme_close";

/**
 * Longer phrases are listed with the shorter ones they contain, because the
 * earliest match wins and "medium close-up" must not be read as "medium".
 */
const PATTERNS: readonly (readonly [ShotSize, RegExp])[] = [
  ["extreme_close", /extreme\s+close[-\s]?ups?|\bECU\b|\bXCU\b/i],
  ["medium_close", /medium\s+close[-\s]?ups?|\bMCU\b/i],
  ["close", /close[-\s]?ups?|\bCU\b/i],
  ["extreme_wide", /extreme\s+(?:wide|long)\s+shots?|establishing\s+shots?|\bEWS\b|\bXWS\b/i],
  ["medium_wide", /medium\s+(?:wide|long)\s+shots?|\bMWS\b/i],
  ["wide", /wide\s+shots?|long\s+shots?|\bWS\b/i],
  ["full", /full\s+shots?|full[-\s]body\s+shots?|\bFS\b/i],
  ["medium", /medium\s+shots?|mid\s+shots?|\bMS\b/i],
];

/**
 * Prompt agents are instructed to open with shot size and camera height, and
 * the cast sheet appended to every prompt is full of words like "shoulders" and
 * "long lean legs". Reading only the opening keeps that text out of range.
 */
const LEAD_CHARS = 160;

/** The shot size a prompt asks for, or undefined when it never states one. */
export function shotSizeOf(text: string | undefined): ShotSize | undefined {
  if (!text) return undefined;
  const lead = text.slice(0, LEAD_CHARS);
  let best: { size: ShotSize; at: number; len: number } | undefined;
  for (const [size, pattern] of PATTERNS) {
    const m = lead.match(pattern);
    if (!m || m.index === undefined) continue;
    // Earliest wins; on a tie the longer phrase is the more specific one.
    if (!best || m.index < best.at || (m.index === best.at && m[0].length > best.len)) {
      best = { size, at: m.index, len: m[0].length };
    }
  }
  return best?.size;
}

/** Any named transition marks a new shot; continuous action is not "cut to". */
const NEW_SHOT_TRANSITION = /\b(?:cut|dissolve|fade|wipe|smash|jump)\b/i;

export type SeamBreak = {
  reason: "shot_size_change" | "transition";
  detail: string;
};

/**
 * Report why this scene cannot inherit the previous scene's end frame, or null
 * when the seam is continuous.
 *
 * Shot size is checked first because it is the stronger evidence: a storyboard
 * that goes from a wide two-shot to an extreme close-up has planned a cut
 * whatever its transition field happens to say.
 */
export function seamBreak(previous: Scene, scene: Scene): SeamBreak | null {
  const from = shotSizeOf(previous.prompts?.endFramePrompt) ?? shotSizeOf(previous.visualDescription);
  const to = shotSizeOf(scene.prompts?.startFramePrompt) ?? shotSizeOf(scene.visualDescription);
  if (from && to && from !== to) {
    return { reason: "shot_size_change", detail: `${label(from)} to ${label(to)}` };
  }
  if (scene.transitionIn && NEW_SHOT_TRANSITION.test(scene.transitionIn)) {
    return { reason: "transition", detail: scene.transitionIn };
  }
  return null;
}

const LABELS: Record<ShotSize, string> = {
  extreme_wide: "extreme wide",
  wide: "wide",
  full: "full",
  medium_wide: "medium wide",
  medium: "medium",
  medium_close: "medium close-up",
  close: "close-up",
  extreme_close: "extreme close-up",
};

/**
 * Where a per-segment shot plan cuts against itself on a continuous take.
 *
 * The Cinematographer writes all of a project's shot plans in one response and
 * does not reliably carry the framing across them — a live 18-segment plan
 * changed size at 12 of 17 seams. That is invisible until the renders come back
 * looking like an edit, so the plan is checked and the seams reported.
 */
export function shotPlanBreaks(
  sceneShotPlans: Record<string, string>,
): { from: number; to: number; detail: string }[] {
  const numbered = Object.keys(sceneShotPlans)
    .map((k) => ({ n: Number(k), text: sceneShotPlans[k]! }))
    .filter((e) => Number.isFinite(e.n))
    .sort((a, b) => a.n - b.n);

  const breaks: { from: number; to: number; detail: string }[] = [];
  for (let i = 1; i < numbered.length; i += 1) {
    // The plan may name a start and an end size; the seam compares the end of
    // one segment with the start of the next.
    const previous = endSizeOf(numbered[i - 1]!.text);
    const next = shotSizeOf(numbered[i]!.text);
    if (!previous || !next || previous === next) continue;
    breaks.push({
      from: numbered[i - 1]!.n,
      to: numbered[i]!.n,
      detail: `${label(previous)} to ${label(next)}`,
    });
  }
  return breaks;
}

/** The last size named in a plan entry, which is where that segment leaves the camera. */
function endSizeOf(text: string): ShotSize | undefined {
  const lead = text.slice(0, LEAD_CHARS);
  let best: { size: ShotSize; at: number } | undefined;
  for (const [size, pattern] of PATTERNS) {
    for (const m of lead.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      if (m.index === undefined) continue;
      if (!best || m.index > best.at) best = { size, at: m.index };
    }
  }
  return best?.size ?? shotSizeOf(text);
}

export function label(size: ShotSize): string {
  return LABELS[size];
}
