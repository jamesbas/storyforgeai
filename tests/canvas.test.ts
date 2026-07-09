import { describe, it, expect } from "vitest";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import {
  artDirectionPlanSchema,
  cinematographyPlanSchema,
  creativeVariantSchema,
  directorialPlanSchema,
  worldBibleSchema,
} from "@/lib/schemas/canvas";
import {
  buildArtDirectionPlan,
  buildCinematographyPlan,
  buildDirectorialPlan,
  buildVariants,
  buildWorldBible,
} from "@/lib/agents/mock-canvas";

function makeProject(): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "canvas-project",
    title: "Canvas Project",
    concept: "A mural comes to life at night.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "animated",
    tone: "whimsical",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

describe("canvas artifact schemas", () => {
  const project = makeProject();

  it("builds 3 schema-valid variants", () => {
    const variants = buildVariants(project);
    expect(variants).toHaveLength(3);
    for (const v of variants) expect(() => creativeVariantSchema.parse(v)).not.toThrow();
  });

  it("builds a schema-valid world bible", () => {
    expect(() => worldBibleSchema.parse(buildWorldBible(project))).not.toThrow();
  });

  it("builds a schema-valid directorial plan with per-scene intent", () => {
    const plan = buildDirectorialPlan(project);
    expect(() => directorialPlanSchema.parse(plan)).not.toThrow();
    expect(Object.keys(plan.sceneIntent)).toHaveLength(project.segmentCount);
  });

  it("builds a schema-valid cinematography plan with per-scene shot plans", () => {
    const plan = buildCinematographyPlan(project);
    expect(() => cinematographyPlanSchema.parse(plan)).not.toThrow();
    expect(Object.keys(plan.sceneShotPlans)).toHaveLength(project.segmentCount);
  });

  it("builds a schema-valid art direction plan", () => {
    expect(() => artDirectionPlanSchema.parse(buildArtDirectionPlan(project))).not.toThrow();
  });
});
