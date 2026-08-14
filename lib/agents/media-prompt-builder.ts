import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";
import { shotSizeOf, type ShotSize } from "@/lib/media/seam";
import { sceneCreativeSlice, type CreativePlans } from "@/lib/agents/creative-context";
import type { MediaPromptSpec } from "@/lib/agents/media-prompt-spec";

/**
 * Build a `MediaPromptSpec` from a scene card (SPEC-003 slice 2).
 *
 * This is where the deterministic path stopped being equivalent to the LLM
 * path: the card carries the facts, but the old builder concatenated them in
 * the order they happened to be declared rather than the order the contract
 * requires. Nothing here invents content — every field is derived from the
 * card, the plan slice or the project, and an absent fact stays absent rather
 * than being filled with a plausible default.
 */

/** Human-readable shot sizes, keyed by the coarse sizes the seam detector knows. */
const SHOT_LABELS: Record<ShotSize, string> = {
  extreme_wide: "Extreme wide shot",
  wide: "Wide shot",
  full: "Full shot",
  medium_wide: "Medium wide shot",
  cowboy: "Cowboy shot",
  medium: "Medium shot",
  medium_close: "Medium close-up",
  close: "Close-up",
  extreme_close: "Extreme close-up",
};

const HEIGHT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["low angle", /\blow[-\s]angle\b|\bworm'?s[-\s]eye\b|\bfrom below\b/i],
  ["high angle", /\bhigh[-\s]angle\b|\bbird'?s[-\s]eye\b|\bfrom above\b|\boverhead\b/i],
  ["dutch angle", /\bdutch\b|\bcanted\b/i],
  ["eye level", /\beye[-\s]level\b/i],
  ["shoulder height", /\bover[-\s]the[-\s]shoulder\b|\bOTS\b/i],
];

const LENS_PATTERN = /\b(\d{2,3})\s?mm\b/i;

/** The phrases that state framing, for removal once framing leads the prompt. */
const FRAMING_PHRASES: readonly RegExp[] = [
  /\b(?:extreme\s+)?(?:wide|long)\s+shots?\b/gi,
  /\bestablishing\s+shots?\b/gi,
  /\b(?:extreme|medium)\s+close[-\s]?ups?\b/gi,
  /\bclose[-\s]?ups?\b/gi,
  /\b(?:medium|full|cowboy|mid)\s+shots?\b/gi,
  /\b(?:low|high|dutch|canted)[-\s]angle\b/gi,
  /\beye[-\s]level\b/gi,
  /\bfrom (?:above|below)\b/gi,
  /\b\d{2,3}\s?mm\b/gi,
];

/**
 * Remove framing wording from the subject line.
 *
 * The card's visual description usually opens with the shot size, and that has
 * already been promoted to the front of the prompt. Left in place it renders as
 * "Medium close-up, low angle. Medium close-up of the apprentice...", which
 * weights the framing twice and reads like a stutter.
 */
export function stripFraming(text: string): string {
  let out = text;
  for (const pattern of FRAMING_PHRASES) out = out.replace(pattern, "");
  return out
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.]+/, "")
    .replace(/[\s,;:]+$/, "")
    .replace(/^of\s+/i, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim();
}

/**
 * Read framing from whatever stated it.
 *
 * The Cinematographer's shot plan is the strongest source, then the scene's own
 * visual description. Camera height defaults to eye level only when nothing
 * names one — a default is honest here because every shot has a height and an
 * unstated one renders as eye level anyway.
 */
export function deriveFraming(
  scene: SceneDraft,
  shotPlan: string | undefined,
): MediaPromptSpec["framing"] {
  const sources = [shotPlan, scene.visualDescription, scene.cameraMovement].filter(
    (s): s is string => Boolean(s?.trim()),
  );
  const joined = sources.join(" ");

  let shotSize: string | undefined;
  for (const source of sources) {
    const size = shotSizeOf(source);
    if (size) {
      shotSize = SHOT_LABELS[size];
      break;
    }
  }

  let cameraHeight: string | undefined;
  for (const [label, pattern] of HEIGHT_PATTERNS) {
    if (pattern.test(joined)) {
      cameraHeight = label;
      break;
    }
  }

  const lens = joined.match(LENS_PATTERN)?.[0]?.replace(/\s+/g, "");

  return {
    shotSize: shotSize ?? "Medium shot",
    cameraHeight: cameraHeight ?? "eye level",
    ...(lens ? { lens } : {}),
  };
}

function stripTrailing(text: string | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

function firstSentence(text: string | undefined): string {
  const trimmed = stripTrailing(text);
  if (!trimmed) return "";
  return trimmed.match(/[^.!?]+[.!?]?/)?.[0]?.trim() ?? trimmed;
}

/**
 * The scene card has no setting or lighting field, so these come from the plans
 * when the canvas agents have run.
 *
 * Left blank when nothing states them, which the lint then reports honestly —
 * "no lighting stated" is true, and on FLUX it is the highest-leverage thing
 * missing. Inventing a plausible default here would hide that.
 */
function deriveSetting(scene: SceneDraft, plans: CreativePlans | undefined): string {
  const named = plans?.worldBible?.locations?.find((location) =>
    new RegExp(`\\b${location.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
      `${scene.visualDescription} ${scene.sceneObjective} ${scene.title}`,
    ),
  );
  return named ? stripTrailing(`${named.name}, ${named.description}`) : "";
}

function deriveLighting(plans: CreativePlans | undefined): string {
  return firstSentence(plans?.cinematographyPlan?.lightingRules?.[0]);
}

/** Verbs a camera note may already start with, so "makes a" is not doubled up. */
const CAMERA_VERBS =
  /^(pushes|pulls|tracks|pans|tilts|dollies|orbits|follows|cranes|zooms|holds|moves|drifts|rises|descends|circles|arcs|whips|racks|glides|floats|sweeps|stays|remains|begins|starts)\b/i;

/**
 * The camera behaviour, phrased so it reads after "The camera ...".
 *
 * Cards state this as a noun phrase ("Slow push-in on the subject"), which
 * concatenated straight into "The camera slow push-in on the subject" —
 * ungrammatical, and in every prompt the old builder wrote.
 *
 * A card that says "static" or "locked off" is stating a real decision, and
 * both Wan and LTX want it said explicitly rather than left out.
 */
export function deriveCameraMotion(scene: SceneDraft): string {
  const raw = stripTrailing(scene.cameraMovement).replace(/[.!?]+$/, "");
  if (!raw) return "";
  if (/^(static|locked|fixed|none|no movement)/i.test(raw)) return "holds a fixed frame";
  const lowered = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (CAMERA_VERBS.test(lowered)) return lowered;
  return `makes a ${lowered}`;
}

/**
 * Split the card's action into the one dominant movement and at most one
 * secondary movement (FR-4).
 *
 * A card frequently describes several things happening. Handing all of them to
 * an image-to-video model produces an average of all of them, so the first is
 * promoted and the second kept as a subordinate; the rest are dropped, which is
 * the whole point of a motion budget.
 */
export function splitMotion(actionDescription: string): { dominant: string; secondary?: string } {
  const text = stripTrailing(actionDescription);
  if (!text) return { dominant: "" };
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const [first, second] = sentences;
  return {
    dominant: (first ?? text).replace(/[.!?]+$/, ""),
    ...(second ? { secondary: second.replace(/[.!?]+$/, "") } : {}),
  };
}

export function buildMediaPromptSpec(
  project: Project,
  scene: SceneDraft,
  plans: CreativePlans | undefined,
  wardrobe: SceneWardrobe | undefined,
): MediaPromptSpec {
  const slice = sceneCreativeSlice(plans, scene);
  const motion = splitMotion(scene.actionDescription);
  const isLast = scene.sceneNumber === project.segmentCount;

  const continuity: string[] = [];
  // A scene depicting a costume change is the one place the two frames are
  // meant to differ in wardrobe, so the usual "same wardrobe" rule is dropped.
  continuity.push(
    wardrobe?.within.length
      ? "Same characters and location as the start frame, in the changed outfit"
      : "Same characters, wardrobe, and location as the start frame",
  );
  if (slice.intent) continuity.push(`Scene intent: ${slice.intent}`);

  return {
    framing: deriveFraming(scene, slice.shotPlan),
    subject: stripFraming(stripTrailing(scene.visualDescription)),
    setting: deriveSetting(scene, plans),
    lighting: deriveLighting(plans),
    composition: slice.shotPlan ? stripTrailing(slice.shotPlan) : undefined,
    // The start frame used to be the story beat alone, which left the opening
    // keyframe generic whenever the scene's physical state was recorded in the
    // action rather than the beat — the same asymmetry the deterministic
    // builder had, one layer down.
    startState: stripTrailing(
      motion.dominant
        ? `${stripTrailing(scene.storyBeat).replace(/[.!?]+$/, "")}, at the first instant of ${motion.dominant}`
        : scene.storyBeat,
    ),
    endState: stripTrailing(
      motion.dominant
        ? `${motion.dominant}${isLast ? ", on a resolving beat" : ""}`
        : scene.storyBeat,
    ),
    dominantMotion: motion.dominant,
    secondaryMotion: motion.secondary,
    cameraMotion: deriveCameraMotion(scene),
    dialogue: (scene.dialogue ?? []).map((d) => ({ speaker: d.character, line: d.line })),
    narration: scene.narrationText ?? undefined,
    continuity,
    exclusions: [],
  };
}
