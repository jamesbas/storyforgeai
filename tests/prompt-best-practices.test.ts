import { describe, it, expect } from "vitest";
import {
  negativeTerms,
  normaliseNegative,
  positiveConstraintClause,
} from "@/lib/agents/negative-prompt";
import { familyOf, supportsNegativePrompt } from "@/lib/wangp/family";
import { imagePromptDirective, videoPromptDirective, hasNativeAudio } from "@/lib/agents/model-directives";

/**
 * Prompt construction judged against each model developer's own guidance.
 *
 * The families disagree in ways a single undifferentiated prompt cannot serve:
 * FLUX discards a negative prompt outright, Wan asks for motion and camera and
 * little else, LTX writes its soundtrack from the same text.
 */

describe("reading a negative prompt as a sampler does", () => {
  it("strips the negation that a text encoder cannot act on", () => {
    expect(normaliseNegative("no watermarks, no distorted anatomy, low quality")).toBe(
      "watermarks, distorted anatomy, low quality",
    );
  });

  it("handles the other ways a person writes an exclusion", () => {
    expect(negativeTerms("without glasses, avoid blur, not elderly")).toEqual([
      "glasses",
      "blur",
      "elderly",
    ]);
  });

  /** A term repeated twice pulls twice as hard, and terms arrive from several appenders. */
  it("drops duplicates that separate appenders cannot see", () => {
    expect(normaliseNegative("watermark, no watermark, WATERMARK")).toBe("watermark");
  });

  it("leaves an already-clean list alone", () => {
    const clean = "watermark, distorted anatomy, low quality";
    expect(normaliseNegative(clean)).toBe(clean);
  });

  it("survives a prompt that is only negations", () => {
    expect(normaliseNegative("no, not, ,")).toBe("");
  });
});

describe("folding exclusions into the prompt for models that ignore them", () => {
  /** BFL's point is not that FLUX ignores negatives but that naming the alternative works. */
  it("names what to render instead of what to avoid", () => {
    const clause = positiveConstraintClause("blurry, cluttered, distorted anatomy");
    expect(clause).toContain("crisp subject detail");
    expect(clause).toContain("sparse, uncluttered setting");
    expect(clause).toContain("correct natural anatomy");
  });

  /** An unmapped term still has to travel, or the user's intent is silently dropped. */
  it("keeps terms it has no alternative for", () => {
    const clause = positiveConstraintClause("glasses, moustache");
    expect(clause).toContain("free of glasses and moustache");
  });

  it("says nothing when there is nothing to exclude", () => {
    expect(positiveConstraintClause("")).toBe("");
  });

  it("does not repeat one alternative for two terms that share it", () => {
    const clause = positiveConstraintClause("watermark, signature, logo");
    expect(clause.match(/clean unmarked surfaces/g)).toHaveLength(1);
  });
});

describe("identifying the model family", () => {
  it("recognises the checkpoints this project actually pins", () => {
    expect(familyOf("flux2_klein_base_9b")).toBe("flux");
    expect(familyOf("qwen_image_edit_plus2_20B")).toBe("qwen");
    expect(familyOf("ltx2_22B_distilled_1_1")).toBe("ltx");
    expect(familyOf("wan2_2_i2v_A14B")).toBe("wan");
  });

  it("prefers WanGP's own metadata when it has any", () => {
    expect(familyOf("some_variant", "ltx2")).toBe("ltx");
  });

  it("admits when it does not know", () => {
    expect(familyOf("hunyuan_video")).toBe("unknown");
    expect(familyOf(undefined)).toBe("unknown");
  });

  /**
   * The routing decision. FLUX and Krea have no dependable negative prompt;
   * an unknown model keeps one, because WanGP only sets fields a schema
   * declares, so an unusable negative is discarded harmlessly anyway.
   */
  it("withholds a negative prompt only from the families that discard it", () => {
    expect(supportsNegativePrompt("flux")).toBe(false);
    expect(supportsNegativePrompt("krea")).toBe(false);
    expect(supportsNegativePrompt("qwen")).toBe(true);
    expect(supportsNegativePrompt("wan")).toBe(true);
    expect(supportsNegativePrompt("ltx")).toBe(true);
    expect(supportsNegativePrompt("unknown")).toBe(true);
  });
});

describe("family-tuned agent directives", () => {
  it("tells the image agent to write FLUX exclusions positively", () => {
    expect(imagePromptDirective("flux")).toMatch(/no negative prompt/i);
  });

  it("tells the image agent to quote literal copy for Qwen", () => {
    expect(imagePromptDirective("qwen")).toMatch(/quotation marks/i);
  });

  /** A directive written for the wrong family is worse than none. */
  it("says nothing when the family is unknown", () => {
    expect(imagePromptDirective("unknown")).toBe("");
    expect(videoPromptDirective("unknown", { segmentSeconds: 8, nativeAudio: false })).toBe("");
  });

  it("gives Wan its motion-plus-camera formula", () => {
    const directive = videoPromptDirective("wan", { segmentSeconds: 8, nativeAudio: false });
    expect(directive).toMatch(/motion plus camera/i);
    expect(directive).toMatch(/fixed camera/i);
  });

  it("asks LTX for audio only when the model writes it", () => {
    const withAudio = videoPromptDirective("ltx", { segmentSeconds: 8, nativeAudio: true });
    expect(withAudio).toMatch(/soundtrack/i);
    expect(withAudio).toContain("8 seconds");

    const silent = videoPromptDirective("ltx", { segmentSeconds: 8, nativeAudio: false });
    expect(silent).not.toMatch(/soundtrack/i);
    expect(silent).toMatch(/present tense/i);
  });

  it("knows LTX is the only family here that writes its own audio", () => {
    expect(hasNativeAudio("ltx")).toBe(true);
    expect(hasNativeAudio("wan")).toBe(false);
  });
});
