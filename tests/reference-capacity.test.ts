import { describe, it, expect } from "vitest";
import { referenceImageCapacity } from "@/lib/wangp/model-router";
import type { WangpModel } from "@/lib/schemas/wangp";

/**
 * How many reference images a model is offered.
 *
 * It used to be `modelType.startsWith("flux2") ? 4 : 2` — a prefix guess that
 * never consulted the catalogue. Every reference-capable model on a live server
 * advertises `multiple_references` beside `reference`, and two of them describe
 * themselves as built for combining several subjects, so the guess was holding
 * them at a number nothing had measured. It also offered two to a model that
 * accepts none, and to one that accepts exactly one.
 */

function model(
  modelType: string,
  image?: { reference?: boolean; multipleReferences?: boolean },
  family?: string,
): WangpModel {
  return {
    modelType,
    name: modelType,
    metadata: {
      mainOutput: "image",
      inputs: ["text", "image"],
      ...(image ? { mediaInputs: { image } } : {}),
      ...(family ? { family } : {}),
    },
  } as unknown as WangpModel;
}

describe("reference image capacity", () => {
  it("offers several to a model advertising multiple_references", () => {
    // Qwen Image Edit Plus, live: "optimized to combine multiple Subjects".
    expect(
      referenceImageCapacity(
        model("qwen_image_edit_plus_20B", { reference: true, multipleReferences: true }, "qwen"),
      ),
    ).toBe(4);
  });

  it("offers exactly one where only a single reference is advertised", () => {
    expect(
      referenceImageCapacity(model("some_single_ref_model", { reference: true })),
    ).toBe(1);
  });

  it("offers none to a model that takes no reference at all", () => {
    expect(referenceImageCapacity(model("krea2_turbo", { reference: false }))).toBe(0);
  });

  /** A published ceiling beats an inferred one. */
  it("honours a family's own stated limit", () => {
    // "Up to two Reference Images can be provided" — the model's own description.
    expect(
      referenceImageCapacity(
        model("krea2_turbo_edit", { reference: true, multipleReferences: true }, "krea2"),
      ),
    ).toBe(2);
  });

  /** Fixtures and pre-discovery models have no media inputs to read. */
  it("keeps the historical answer when the model advertises nothing", () => {
    expect(referenceImageCapacity(model("flux2_klein_9b"))).toBe(4);
    expect(referenceImageCapacity(model("anything_else"))).toBe(2);
  });
});
