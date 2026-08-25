import { describe, expect, it } from "vitest";

import { singlePromptGenType } from "@/lib/wangp/settings";
import type { WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * Wan2GP reads a line break in the prompt as a boundary between generations.
 *
 * Its saved state arrives as `multi_prompts_gen_type: "PG"`, so a four-paragraph
 * prompt becomes four generation requests against the one task that was
 * submitted — the server rejects the mismatch, and where it does not, the clip
 * bears no relation to any of the sections. `"FG"` means the line breaks are
 * just text.
 */
function schema(defaults: Record<string, unknown>): WangpModelSchema {
  return { modelType: "m", defaultSettings: defaults, fields: [] } as WangpModelSchema;
}

describe("a prompt that spans more than one line", () => {
  it("asks for one generation when the model would otherwise split it", () => {
    expect(singlePromptGenType(schema({ multi_prompts_gen_type: "PG" }), "One.\n\nTwo.")).toBe("FG");
  });

  it("leaves a single-line prompt alone", () => {
    // One paragraph is one generation either way; changing it would be a
    // setting written for no reason.
    expect(singlePromptGenType(schema({ multi_prompts_gen_type: "PG" }), "One line.")).toBeUndefined();
  });

  it("says nothing to a model that does not publish the setting", () => {
    expect(singlePromptGenType(schema({}), "One.\n\nTwo.")).toBeUndefined();
  });

  it("handles a carriage-return line ending", () => {
    expect(singlePromptGenType(schema({ multi_prompts_gen_type: "PG" }), "One.\r\nTwo.")).toBe("FG");
  });

  it("ignores a prompt that is not a string", () => {
    expect(singlePromptGenType(schema({ multi_prompts_gen_type: "PG" }), undefined)).toBeUndefined();
  });
});
