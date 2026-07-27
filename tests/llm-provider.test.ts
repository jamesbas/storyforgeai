import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeSchema, withSchemaHint } from "@/lib/agents/llm/schema-hint";
import { extractJsonObject, isResponseFormatRejection } from "@/lib/agents/llm/provider";
import { scenePromptsSchema } from "@/lib/schemas/storyboard";

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
