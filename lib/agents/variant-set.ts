import type { Project } from "@/lib/schemas/project";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import { buildVariants, DETERMINISTIC_AXES } from "@/lib/agents/mock-canvas";

export { DETERMINISTIC_AXES };

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
