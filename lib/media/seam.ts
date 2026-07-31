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
  | "cowboy"
  | "medium"
  | "medium_close"
  | "close"
  | "extreme_close";

/** Wide to tight. Adjacency is what makes a camera move plausible. */
const SIZE_ORDER: readonly ShotSize[] = [
  "extreme_wide",
  "wide",
  "full",
  "medium_wide",
  "cowboy",
  "medium",
  "medium_close",
  "close",
  "extreme_close",
];

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
  ["cowboy", /\bcowboy\s+shots?\b|\bcowboy\b/i],
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
  cowboy: "cowboy",
  medium: "medium",
  medium_close: "medium close-up",
  close: "close-up",
  extreme_close: "extreme close-up",
};

/**
 * Where a per-segment shot plan contradicts the take it claims to be.
 *
 * Three separate faults, all found in live plans. The seam fault is a segment
 * opening on a size the last one never reached. The move fault is a segment
 * whose stated movement cannot produce its own size change — a push-in that
 * ends wider. The rig fault is a lens or camera height changing partway
 * through, which no unbroken take can do.
 *
 * Fixing only the seams moved the contradiction inside the segments, so all
 * three are checked together.
 */
export type ShotPlanIssue = {
  kind: "seam" | "move" | "lens" | "height";
  /** Segment the fault is reported against. */
  at: number;
  detail: string;
};

const INWARD = /push[-\s]?in|dolly\s+in|zoom\s+in|move\s+in|closer/i;
const OUTWARD = /pull[-\s]?out|pull\s+back|dolly\s+out|zoom\s+out|widen|reveal/i;

export function shotPlanIssues(sceneShotPlans: Record<string, string>): ShotPlanIssue[] {
  const numbered = Object.keys(sceneShotPlans)
    .map((k) => ({ n: Number(k), text: sceneShotPlans[k]! }))
    .filter((e) => Number.isFinite(e.n))
    .sort((a, b) => a.n - b.n);

  const issues: ShotPlanIssue[] = [];
  const lenses = new Map<string, number>();
  let previousHeight: string | undefined;

  for (let i = 0; i < numbered.length; i += 1) {
    const { n, text } = numbered[i]!;
    const from = shotSizeOf(text);
    const to = endSizeOf(text);

    // A move that goes the opposite way to the size change it claims.
    if (from && to && from !== to) {
      const tighter = SIZE_ORDER.indexOf(to) > SIZE_ORDER.indexOf(from);
      const inward = INWARD.test(text);
      const outward = OUTWARD.test(text);
      if (tighter && outward && !inward) {
        issues.push({ kind: "move", at: n, detail: `pulls out but ends tighter (${label(from)} to ${label(to)})` });
      } else if (!tighter && inward && !outward) {
        issues.push({ kind: "move", at: n, detail: `pushes in but ends wider (${label(from)} to ${label(to)})` });
      }
    }

    const lens = text.match(/(\d{2,3})\s*mm/)?.[1];
    if (lens) lenses.set(lens, (lenses.get(lens) ?? 0) + 1);

    // Height is not like lens: an operator walks, a crane rises, so a moving
    // camera may legitimately end up somewhere else. Only a static one cannot.
    const height = heightOf(text);
    if (height && previousHeight && height !== previousHeight && STATIC.test(text)) {
      issues.push({
        kind: "height",
        at: n,
        detail: `is ${height} where segment ${numbered[i - 1]!.n} was ${previousHeight}, with a static camera to carry it`,
      });
    }
    if (height) previousHeight = height;

    if (i === 0) continue;
    const previous = endSizeOf(numbered[i - 1]!.text);
    if (previous && from && previous !== from) {
      issues.push({
        kind: "seam",
        at: n,
        detail: `opens on ${label(from)} but segment ${numbered[i - 1]!.n} ended on ${label(previous)}`,
      });
    }
  }

  // Reported once for the plan rather than per segment: the fault is the set.
  if (lenses.size > 1) {
    issues.push({ kind: "lens", at: 0, detail: `${[...lenses.keys()].sort().join("mm, ")}mm` });
  }
  return issues;
}

const STATIC = /\bstatic\b|\blocked[-\s]?off\b|\bfixed\b/i;

function heightOf(text: string): string | undefined {
  return text
    .match(/eye\s+level|overhead|high\s+angle|low\s+angle|\blow\b|\bhigh\b/i)?.[0]
    .toLowerCase();
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
