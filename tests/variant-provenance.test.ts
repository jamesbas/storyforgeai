import { describe, it, expect } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { computeSegmentation } from "@/lib/duration";
import { variantExplorerAgent } from "@/lib/agents/canvas-agents";
import { buildVariants } from "@/lib/agents/mock-canvas";
import { buildGenerationManifest } from "@/lib/export/serialize";
import { createProject, generateStoryboard, generateVariants } from "@/lib/services/project-service";
import { latestExecution, type ArtifactExecution } from "@/lib/schemas/provenance";
import { describeExecution } from "@/components/shared/execution-badge";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";
import type { VariantType } from "@/lib/types";

function makeProject(): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "variant-prov",
    title: "Variant Provenance",
    concept: "A gardener finds a door in a hedge.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "wistful",
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

const modelVariant = (id: string, variantType: VariantType) => ({
  id,
  projectId: "elsewhere",
  name: `Direction ${id}`,
  variantType,
  summary: "A direction the model wrote.",
  hook: "Open somewhere.",
  storyAngle: "Told a way.",
  visualStyle: "Looks a way.",
  strengths: ["s"],
  risks: ["r"],
  selected: false,
  createdByAgent: "Variant Explorer",
  createdAt: new Date().toISOString(),
});

function providerReturning(variants: unknown[]): PlanningProvider {
  return {
    name: "test-provider",
    generateJson: async <T,>(
      _s: string,
      _u: string,
      schema: ZodType<T, ZodTypeDef, unknown>,
    ): Promise<T | null> => {
      const parsed = schema.safeParse({ variants });
      return parsed.success ? parsed.data : null;
    },
    generate: async <T,>(
      _s: string,
      _u: string,
      schema: ZodType<T, ZodTypeDef, unknown>,
    ): Promise<ProviderResult<T>> => {
      const parsed = schema.safeParse({ variants });
      return parsed.success
        ? { ok: true, value: parsed.data, provider: "test-provider", model: "gemma4-26b" }
        : { ok: false, reason: "schema_mismatch", provider: "test-provider", model: "gemma4-26b" };
    },
  };
}

function failingProvider(): PlanningProvider {
  return {
    name: "test-provider",
    generateJson: async () => null,
    generate: async <T,>(): Promise<ProviderResult<T>> => ({
      ok: false,
      reason: "empty_response",
      provider: "test-provider",
      model: "gemma4-26b",
    }),
  };
}

async function runVariants(provider: PlanningProvider | null) {
  const executions: ArtifactExecution[] = [];
  const variants = await variantExplorerAgent(makeProject(), provider, {
    onExecution: (e) => executions.push(e),
    correlationId: "run-1",
  });
  return { variants, execution: latestExecution(executions, "variants")! };
}

/**
 * Four ways a set of directions can come about, and a creator can act on the
 * difference: a set the model wrote, one the builder patched, one it never
 * touched, and one from before any of this was recorded.
 */
describe("how a variant set says where it came from", () => {
  it("records a clean model set as llm, with the model named", async () => {
    const { variants, execution } = await runVariants(
      providerReturning([
        modelVariant("a", "story"),
        modelVariant("b", "hook"),
        modelVariant("c", "visual_style"),
      ]),
    );

    expect(variants.map((v) => v.name)).toEqual(["Direction a", "Direction b", "Direction c"]);
    expect(execution).toMatchObject({
      artifact: "variants",
      source: "llm",
      status: "ok",
      model: "gemma4-26b",
      correlationId: "run-1",
    });
    expect(execution.fallbackReason).toBeUndefined();
    expect(describeExecution(execution)).toBe("LLM · gemma4-26b");
  });

  it("cannot store duplicate axes silently: the set is repaired and says so", async () => {
    const { variants, execution } = await runVariants(
      providerReturning([
        modelVariant("a", "concept"),
        modelVariant("b", "concept"),
        modelVariant("c", "concept"),
      ]),
    );

    // The set is fixed...
    expect(new Set(variants.map((v) => v.variantType)).size).toBe(3);
    // ...and the fix is on the record, not just in a log line.
    expect(execution).toMatchObject({
      source: "hybrid",
      status: "degraded",
      fallbackReason: "invalid_set",
      attempted: { total: 3, fromLlm: 1 },
    });
    expect(describeExecution(execution)).toBe("Hybrid · 1/3 from the model");
  });

  it("counts exactly how many directions survived a repair", async () => {
    const { execution } = await runVariants(
      providerReturning([
        modelVariant("a", "story"),
        modelVariant("b", "hook"),
        modelVariant("c", "hook"),
      ]),
    );

    // Two distinct axes kept, one duplicate replaced.
    expect(execution.attempted).toEqual({ total: 3, fromLlm: 2 });
    expect(execution.detail).toBe("2 of 3 directions kept from the model");
  });

  it("records a short model set as a filled hybrid", async () => {
    const { execution } = await runVariants(providerReturning([modelVariant("a", "story")]));

    expect(execution).toMatchObject({
      source: "hybrid",
      status: "degraded",
      fallbackReason: "short_collection",
      attempted: { total: 3, fromLlm: 1 },
    });
  });

  it("records a provider failure as a full deterministic fallback", async () => {
    const { variants, execution } = await runVariants(failingProvider());

    expect(variants).toEqual(buildVariants(makeProject()).map((v, i) => ({
      ...v,
      createdAt: variants[i]!.createdAt,
    })));
    expect(execution).toMatchObject({
      source: "deterministic",
      status: "degraded",
      fallbackReason: "empty_response",
      model: "gemma4-26b",
    });
    expect(describeExecution(execution)).toBe("Deterministic");
  });

  it("does not call demo mode a provider failure", async () => {
    const { execution } = await runVariants(null);

    expect(execution).toMatchObject({
      source: "deterministic",
      // The distinction SPEC-005B turns on: nobody asked for a model.
      status: "ok",
      fallbackReason: "provider_disabled",
    });
    expect(execution.provider).toBeUndefined();
    expect(describeExecution(execution)).toBe("Deterministic");
  });

  it("says a legacy set has no provenance rather than guessing", () => {
    expect(latestExecution(undefined, "variants")).toBeUndefined();
    expect(describeExecution(undefined)).toBe("No provenance (legacy project)");
  });

  it("keeps no prompt, response body or credential on the record", async () => {
    const { execution } = await runVariants(
      providerReturning([
        modelVariant("a", "concept"),
        modelVariant("b", "concept"),
        modelVariant("c", "concept"),
      ]),
    );

    const serialized = JSON.stringify(execution);
    expect(serialized).not.toContain("You are the Variant Explorer");
    expect(serialized).not.toContain("A gardener finds a door");
    expect(serialized).not.toContain("Direction a");
  });

  it("uses one execution id per run and reuses the shared artifact key", async () => {
    const first = await runVariants(null);
    const second = await runVariants(null);

    expect(first.execution.artifact).toBe("variants");
    expect(second.execution.artifact).toBe("variants");
    expect(first.execution.executionId).not.toBe(second.execution.executionId);
  });

  it("exports the set's source through the shared provenance section", async () => {
    const project = await createProject({
      concept: "A gardener finds a door in a hedge.",
      requestedDurationSeconds: 60,
    });
    await generateVariants(project.id);
    const record = await generateStoryboard(project.id);

    const manifest = buildGenerationManifest(record) as {
      provenance: ArtifactExecution[] | null;
    };
    const variantRecord = manifest.provenance?.find((e) => e.artifact === "variants");

    // Exported through SPEC-004's section, not a variant-specific one.
    expect(variantRecord).toMatchObject({ source: "deterministic", status: "ok" });
    expect(JSON.stringify(manifest)).not.toContain("You are the Variant Explorer");
  });
});
