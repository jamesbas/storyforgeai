import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief } from "@/lib/schemas/agents";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import { buildVariants, DETERMINISTIC_AXES } from "@/lib/agents/mock-canvas";

export { DETERMINISTIC_AXES };

/**
 * Fold the chosen direction into the brief every later agent reads.
 *
 * Shared because it was not: the orchestrator did this and the canvas path,
 * which generates the Story Plan when the Director is run first, only put the
 * variant on the context object. Nothing downstream reads that field \u2014 the
 * Story Architect is sent `{ project, brief }` \u2014 so running the Director first
 * produced an arc written as though no direction had been chosen, and it was
 * then reused by the storyboard forever.
 *
 * `risks` are carried as tradeoffs, not exclusions. The Variant Explorer is
 * told they name "what this direction gives up", so turning them into
 * "Avoid: less emotional depth" inverted a description of the cost into an
 * instruction to work against the direction the creator picked.
 */
export function applyVariantToBrief(
  brief: CreativeBrief,
  variant: CreativeVariant | undefined,
): CreativeBrief {
  if (!variant) return brief;
  const direction = [
    `Selected direction: ${variant.name} — ${variant.summary}`,
    variant.hook ? `Hook: ${variant.hook}` : null,
    variant.storyAngle ? `Story angle: ${variant.storyAngle}` : null,
    variant.visualStyle ? `Visual style: ${variant.visualStyle}` : null,
    variant.risks.length
      ? `Tradeoffs this direction accepts (context, not instructions): ${variant.risks.join("; ")}`
      : null,
  ].filter((line): line is string => line !== null);
  return { ...brief, constraints: [...brief.constraints, ...direction] };
}

/** What is wrong with a set, as a code safe to log. */
export type VariantSetIssue = "wrong_count" | "duplicate_axis";

const VARIANT_COUNT = 3;

/**
 * Check a set rather than its members.
 *
 * Every variant here already parsed against `creativeVariantSchema`, which is
 * why duplicate axes used to be stored silently: the schema validates one
 * variant at a time and cannot see that all three claim to change the premise.
 */
export function validateVariantSet(variants: CreativeVariant[]): VariantSetIssue[] {
  const issues: VariantSetIssue[] = [];
  if (variants.length !== VARIANT_COUNT) issues.push("wrong_count");
  if (new Set(variants.map((v) => v.variantType)).size !== variants.length) {
    issues.push("duplicate_axis");
  }
  return issues;
}

export type VariantSetRepair = {
  variants: CreativeVariant[];
  issues: VariantSetIssue[];
  /** Indices of the returned set that came from the deterministic templates. */
  replaced: number[];
};

/**
 * Make a set offer three distinct axes, keeping as much of the model's work as
 * possible.
 *
 * The first variant claiming an axis keeps it; later duplicates and any
 * shortfall are filled from the deterministic templates for the axes nobody
 * covered. Asking the model again is the alternative, but a second call costs
 * the same latency and can return the same duplicates.
 *
 * Nothing about the repair is written onto the variants themselves — visible
 * provenance is SPEC-004/005B's to own. `replaced` is returned for telemetry.
 */
export function repairVariantSet(
  project: Project,
  variants: CreativeVariant[],
): VariantSetRepair {
  const issues = validateVariantSet(variants);
  if (!issues.length) return { variants, issues, replaced: [] };

  const kept: CreativeVariant[] = [];
  const claimed = new Set<string>();
  for (const variant of variants) {
    if (kept.length === VARIANT_COUNT) break;
    if (claimed.has(variant.variantType)) continue;
    claimed.add(variant.variantType);
    kept.push(variant);
  }

  const templates = buildVariants(project);
  const spare = templates.filter((t) => !claimed.has(t.variantType));
  const replaced: number[] = [];
  const repaired = [...kept];
  while (repaired.length < VARIANT_COUNT) {
    const fill = spare.shift() ?? templates[repaired.length]!;
    replaced.push(repaired.length);
    repaired.push(fill);
  }

  const usedIds = new Set<string>();
  return {
    variants: repaired.map((variant, index) => {
      let id = variant.id;
      if (usedIds.has(id)) id = `${project.id}-variant-${index + 1}-alt`;
      usedIds.add(id);
      return { ...variant, id, projectId: project.id, selected: false };
    }),
    issues,
    replaced,
  };
}
