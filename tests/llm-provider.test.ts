import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { describeSchema, withSchemaHint } from "@/lib/agents/llm/schema-hint";
import { extractJsonObject, isResponseFormatRejection } from "@/lib/agents/llm/provider";
import { maybe } from "@/lib/schemas/maybe";
import {
  scenePromptsSchema,
  sceneSchema,
  sceneDraftSchema,
  storyboardSnapshotSchema,
} from "@/lib/schemas/storyboard";
import { qcResultSchema } from "@/lib/schemas/generation";
import { creativeBriefSchema, storyPlanSchema, visualBibleSchema } from "@/lib/schemas/agents";
import { audioPlanSchema } from "@/lib/schemas/audio";
import {
  worldBibleSchema,
  directorialPlanSchema,
  cinematographyPlanSchema,
  artDirectionPlanSchema,
  creativeVariantSchema,
} from "@/lib/schemas/canvas";

describe("describeSchema", () => {
  it("lists required and optional keys with their types", () => {
    const shape = describeSchema(
      z.object({ a: z.string(), b: z.number().optional(), c: z.boolean() }),
    );
    expect(shape).toBe("{ a: string, b?: number, c: boolean }");
  });

  it("marks defaulted fields as optional for the model", () => {
    expect(describeSchema(z.object({ a: z.string().default("x") }))).toBe("{ a?: string }");
  });

  it("describes enums by their allowed values", () => {
    expect(describeSchema(z.object({ kind: z.enum(["music", "sfx"]) }))).toContain(
      'one of "music"|"sfx"',
    );
  });

  it("describes arrays of primitives and of objects", () => {
    expect(describeSchema(z.object({ tags: z.array(z.string()) }))).toBe(
      "{ tags: array of string }",
    );
    expect(
      describeSchema(z.object({ lines: z.array(z.object({ who: z.string(), text: z.string() })) })),
    ).toBe("{ lines: array of { who: string, text: string } }");
  });

  it("reaches nested objects inside arrays inside arrays", () => {
    // Regression: the storyboard schema nests dialogue objects two arrays deep.
    // At the original depth limit they rendered as a bare "object", so the model
    // never learned the `character` / `line` keys and omitted them.
    const schema = z.object({
      scenes: z.array(
        z.object({
          title: z.string(),
          dialogue: z.array(z.object({ character: z.string(), line: z.string() })),
        }),
      ),
    });
    const shape = describeSchema(schema)!;
    expect(shape).toContain("character: string");
    expect(shape).toContain("line: string");
  });

  it("returns null for a non-object schema", () => {
    expect(describeSchema(z.array(z.string()))).toBeNull();
  });

  it("states numeric bounds so models do not violate them", () => {
    // Observed failure: a 9B model emitted `trimAtEndSeconds: 0` for "no trim"
    // against a .positive() field, because the hint only said "number".
    const shape = describeSchema(
      z.object({ trimAtEndSeconds: z.number().int().positive().optional() }),
    )!;
    expect(shape).toContain("integer");
    expect(shape).toContain("> 0");
  });

  it("renders inclusive bounds and ranges", () => {
    expect(describeSchema(z.object({ p: z.number().min(0).max(100) }))!).toContain(
      ">= 0 and <= 100",
    );
  });

  it("tells the model to omit optional keys rather than send placeholders", () => {
    const hinted = withSchemaHint("Agent.", z.object({ a: z.string().optional() }));
    expect(hinted).toMatch(/omit them entirely/i);
  });

  it("describes a real StoryForge artifact schema", () => {
    const shape = describeSchema(scenePromptsSchema)!;
    expect(shape).toContain("startFramePrompt: string");
    expect(shape).toContain("videoPromptSegment: string");
  });
});

describe("withSchemaHint", () => {
  it("appends the shape and keeps the original instruction", () => {
    const hinted = withSchemaHint("You are the Image Prompt Agent.", z.object({ a: z.string() }));
    expect(hinted).toContain("You are the Image Prompt Agent.");
    expect(hinted).toContain("{ a: string }");
    expect(hinted).toMatch(/exactly this shape/i);
  });

  it("leaves the prompt untouched when there is no useful shape", () => {
    const system = "Return a list.";
    expect(withSchemaHint(system, z.array(z.string()))).toBe(system);
  });
});

describe("extractJsonObject", () => {
  it("parses raw JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers JSON from a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON surrounded by prose", () => {
    expect(extractJsonObject('Sure! Here it is: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it("strips an inline reasoning block before parsing", () => {
    // Some reasoning models inline <think> in content instead of splitting it
    // into reasoning_content.
    expect(extractJsonObject('<think>weighing options</think>\n{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null when there is no JSON at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
  });
});

describe("isResponseFormatRejection", () => {
  it("recognizes the LM Studio rejection", () => {
    expect(isResponseFormatRejection("400 'response_format.type' must be 'json_schema' or 'text'")).toBe(true);
  });

  it("does not treat unrelated failures as format problems", () => {
    expect(isResponseFormatRejection("connect ECONNREFUSED 127.0.0.1:1234")).toBe(false);
  });
});

/**
 * Structured output is the only thing keeping a small local model on-shape, and
 * losing it is silent — the call still returns JSON, just with the wrong keys.
 *
 * A schema OpenAI's strict mode refuses never reaches the server as
 * `json_schema` at all. Bare `.optional()` is the usual cause; `maybe()`
 * expresses the same intent and converts.
 */
describe("schemas that must survive strict JSON Schema conversion", () => {
  const converts = (schema: unknown) => {
    try {
      zodResponseFormat(schema as never, "probe");
      return true;
    } catch {
      return false;
    }
  };

  it("accepts maybe() where strict mode refuses optional", () => {
    expect(converts(z.object({ a: z.string().optional() }))).toBe(false);
    expect(converts(z.object({ a: maybe(z.string()) }))).toBe(true);
  });

  /** Every schema an agent asks a model to fill. Add new ones here. */
  const responseSchemas = {
    creativeBriefSchema,
    storyPlanSchema,
    visualBibleSchema,
    scenePromptsSchema,
    sceneSchema,
    sceneDraftSchema,
    storyboardSnapshotSchema,
    qcResultSchema,
    audioPlanSchema,
    worldBibleSchema,
    directorialPlanSchema,
    cinematographyPlanSchema,
    artDirectionPlanSchema,
    creativeVariantSchema,
  };

  for (const [name, schema] of Object.entries(responseSchemas)) {
    it(`converts ${name}`, () => {
      expect(converts(schema)).toBe(true);
    });
  }
});

/**
 * `maybe()` must stay a drop-in for `.optional()`: an absent value has to stay
 * absent, or every stored record grows explicit nulls.
 */
describe("maybe()", () => {
  const schema = z.object({ a: maybe(z.string()) });

  it("accepts a missing key, a null, and a value", () => {
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ a: null })).toEqual({});
    expect(schema.parse({ a: "x" })).toEqual({ a: "x" });
  });

  it("does not serialise an absent value as null", () => {
    expect(JSON.stringify(schema.parse({ a: null }))).toBe("{}");
  });

  it("still rejects the wrong type", () => {
    expect(schema.safeParse({ a: 7 }).success).toBe(false);
  });
});
