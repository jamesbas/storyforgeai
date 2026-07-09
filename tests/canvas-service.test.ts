import { describe, it, expect } from "vitest";
import {
  createProject,
  generateVariants,
  selectVariant,
  generateStoryboard,
  generateWorldBible,
  generateDirectorialPlan,
  getProjectRecord,
} from "@/lib/services/project-service";

/**
 * Integration: variant generation -> selection -> storyboard from the selected
 * variant, exercising the service layer against the in-memory repository.
 */
describe("agentic canvas service flow", () => {
  it("generates variants, selects one, and threads it into the storyboard", async () => {
    const project = await createProject({
      concept: "A street musician gathers a crowd at dusk.",
      requestedDurationSeconds: 60,
    });

    let record = await generateVariants(project.id);
    expect(record.variants).toHaveLength(3);
    expect(record.selectedVariantId).toBeUndefined();

    const chosen = record.variants![1]!;
    record = await selectVariant(project.id, chosen.id);
    expect(record.selectedVariantId).toBe(chosen.id);
    expect(record.variants!.filter((v) => v.selected)).toHaveLength(1);

    record = await generateStoryboard(project.id);
    expect(record.storyboard).toBeDefined();
    expect(record.storyboard!.brief.constraints).toContain(`Selected direction: ${chosen.name}`);
  });

  it("records decision history for canvas actions", async () => {
    const project = await createProject({
      concept: "A clockmaker races the sunrise.",
      requestedDurationSeconds: 40,
    });
    await generateVariants(project.id);
    await generateWorldBible(project.id);
    await generateDirectorialPlan(project.id);
    const record = await getProjectRecord(project.id);

    expect(record.worldBible).toBeDefined();
    expect(record.directorialPlan).toBeDefined();
    const actions = (record.history ?? []).map((h) => h.action);
    expect(actions).toContain("variants.generated");
    expect(actions).toContain("world_bible.generated");
    expect(actions).toContain("directorial_plan.generated");
  });

  it("rejects selecting an unknown variant", async () => {
    const project = await createProject({
      concept: "A whale sings a city to sleep.",
      requestedDurationSeconds: 20,
    });
    await generateVariants(project.id);
    await expect(selectVariant(project.id, "does-not-exist")).rejects.toThrow();
  });
});
