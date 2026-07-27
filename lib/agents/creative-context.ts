import type {
  ArtDirectionPlan,
  CinematographyPlan,
  DirectorialPlan,
  WorldBible,
} from "@/lib/schemas/canvas";
import type { Character } from "@/lib/schemas/character";

/**
 * Threads the Agentic Canvas plans into the storyboard pipeline.
 *
 * These four agents used to be write-only: their artifacts were stored and
 * displayed, but nothing read them back, so a Director's per-scene intent never
 * influenced a single rendered frame.
 *
 * The reason it is not simply "put the whole plan in every prompt" is that video
 * models truncate, and the signal that matters (subject, action, camera) gets
 * buried behind pages of world-building. So the documents are handed whole to
 * the *planning* agents, which run once and produce prose, while the *prompt*
 * agents receive only the slice that belongs to their scene. That is what the
 * `sceneIntent` and `sceneShotPlans` maps were designed for.
 */

export type CreativePlans = {
  worldBible?: WorldBible;
  directorialPlan?: DirectorialPlan;
  cinematographyPlan?: CinematographyPlan;
  artDirectionPlan?: ArtDirectionPlan;
};

export function hasCreativePlans(plans: CreativePlans | undefined): boolean {
  if (!plans) return false;
  return Boolean(
    plans.worldBible ||
      plans.directorialPlan ||
      plans.cinematographyPlan ||
      plans.artDirectionPlan,
  );
}

/**
 * Look up a per-scene entry.
 *
 * The deterministic builders key these maps by scene number, but a model asked
 * for "a record keyed by scene" will just as happily emit the scene id or
 * "Scene 3". Accepting all three costs nothing and avoids silently dropping the
 * most valuable part of the plan.
 */
function sceneEntry(
  map: Record<string, string> | undefined,
  scene: { id: string; sceneNumber: number },
): string | undefined {
  if (!map) return undefined;
  const candidates = [
    scene.id,
    String(scene.sceneNumber),
    `scene ${scene.sceneNumber}`,
    `Scene ${scene.sceneNumber}`,
  ];
  for (const key of candidates) {
    const value = map[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Last resort: case-insensitive match, so "SCENE 3" still resolves.
  const wanted = `scene ${scene.sceneNumber}`;
  for (const [key, value] of Object.entries(map)) {
    if (key.trim().toLowerCase() === wanted && value.trim()) return value.trim();
  }
  return undefined;
}

export type SceneCreativeSlice = {
  intent?: string;
  shotPlan?: string;
};

/** The portion of the plans that belongs to one specific scene. */
export function sceneCreativeSlice(
  plans: CreativePlans | undefined,
  scene: { id: string; sceneNumber: number },
): SceneCreativeSlice {
  if (!plans) return {};
  return {
    intent: sceneEntry(plans.directorialPlan?.sceneIntent, scene),
    shotPlan: sceneEntry(plans.cinematographyPlan?.sceneShotPlans, scene),
  };
}

function firstFew(values: readonly string[] | undefined, limit: number): string[] {
  return (values ?? [])
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Global rules compact enough to ride along in a render prompt.
 *
 * Deliberately capped: these compete for attention with the scene description,
 * and past a couple of clauses each they cost more adherence than they buy.
 */
export function globalStyleSuffix(plans: CreativePlans | undefined): string {
  if (!plans) return "";
  const parts: string[] = [];

  const wardrobe = firstFew(plans.artDirectionPlan?.wardrobeRules, 1);
  const props = firstFew(plans.artDirectionPlan?.propRules, 1);
  const setDressing = firstFew(plans.artDirectionPlan?.setDressingRules, 1);
  const lighting = firstFew(plans.cinematographyPlan?.lightingRules, 1);
  const lens = firstFew(plans.cinematographyPlan?.lensAndFramingRules, 1);
  const motifs = firstFew(plans.worldBible?.visualAnchors, 1);

  if (plans.artDirectionPlan?.productionDesign) {
    parts.push(plans.artDirectionPlan.productionDesign.trim());
  }
  parts.push(...wardrobe, ...props, ...setDressing, ...lens, ...lighting, ...motifs);

  return parts.length ? ` Art direction: ${parts.join(" ")}` : "";
}

/** Per-scene direction, appended to that scene's prompts only. */
export function sceneDirectionSuffix(slice: SceneCreativeSlice): string {
  const parts: string[] = [];
  if (slice.intent) parts.push(`Scene intent: ${slice.intent}`);
  if (slice.shotPlan) parts.push(`Shot plan: ${slice.shotPlan}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** World-continuity rules that must not be contradicted, for negative prompting. */
export function continuityNegativeSuffix(plans: CreativePlans | undefined): string {
  const forbidden = firstFew(plans?.worldBible?.forbiddenContradictions, 2);
  return forbidden.length ? `, ${forbidden.join(", ")}` : "";
}

/**
 * Precedence rule appended to planning system prompts.
 *
 * Two plans can legitimately disagree — the Art Director specifies a wardrobe
 * while a pinned library character specifies another. Without a stated order the
 * model resolves it differently on every scene, which is exactly the drift the
 * plans were meant to prevent. A pinned character is the strongest explicit
 * signal of user intent, so it wins outright.
 */
export function precedenceDirective(
  cast: readonly Character[],
  plans: CreativePlans | undefined,
): string {
  if (!hasCreativePlans(plans)) return "";
  const order = cast.length
    ? "the pinned character library, then the Visual Bible, then the Art Direction, " +
      "Cinematography and World Bible plans"
    : "the Visual Bible, then the Art Direction, Cinematography and World Bible plans";
  return (
    " Additional approved plans are supplied in the user message. Follow them. " +
    `Where two sources conflict, obey them in this order: ${order}. ` +
    "Never restate a conflict as a compromise: pick the higher-precedence source and apply it exactly."
  );
}

/** Plan documents handed whole to the planning agents (not to render prompts). */
export function planningPayload(plans: CreativePlans | undefined): CreativePlans | undefined {
  return hasCreativePlans(plans) ? plans : undefined;
}
