import { describe, it, expect } from "vitest";
import {
  negatedTraitsIn,
  negativeTerms,
  normaliseNegative,
  positiveConstraintClause,
  withMultiSubjectGuards,
  withNegatedTraits,
  withoutCharacterScopedTerms,
} from "@/lib/agents/negative-prompt";
import { familyOf, negativePromptReaches, supportsNegativePrompt } from "@/lib/wangp/family";
import { imagePromptDirective, videoPromptDirective, hasNativeAudio } from "@/lib/agents/model-directives";
import { WORDS_PER_SECOND } from "@/lib/agents/media-prompt-spec";

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

/**
 * The agents write `dark skin for Jaime`, which reads as per-person direction
 * and is nothing of the sort: a negative prompt has no addressee, so the
 * sampler steers the whole frame away from dark skin — including the character
 * who is supposed to have it.
 */
describe("exclusions the agents aimed at one character", () => {
  const CAST = ["Jaime", "Tracey"];

  it("drops them when more than one person is in frame", () => {
    expect(
      withoutCharacterScopedTerms("blur, dark skin for Jaime, short hair for Tracey", CAST, 3),
    ).toBe("blur");
  });

  /** The agents write both prepositions; catching one left the other unchecked. */
  it("catches the 'on <name>' phrasing as well as 'for <name>'", () => {
    expect(withoutCharacterScopedTerms("blur, black hair on Tracey", CAST, 3)).toBe("blur");
    expect(withoutCharacterScopedTerms("blur, blue eyes to Jaime", CAST, 3)).toBe("blur");
  });

  /** Anchored to a cast name, so an ordinary term containing "on" survives. */
  it("leaves a term that merely contains a preposition alone", () => {
    expect(withoutCharacterScopedTerms("reflections on glass, blur", CAST, 3)).toBe(
      "reflections on glass, blur",
    );
  });

  /** With one person the scope is redundant rather than wrong. */
  it("keeps the trait and drops the name when the frame holds one person", () => {
    expect(withoutCharacterScopedTerms("blur, dark skin for Jaime", CAST, 1)).toBe(
      "blur, dark skin",
    );
  });

  /** An exclusion that cannot be aimed is a liability, so silence is not consent. */
  it("drops them when the prompt states no population", () => {
    expect(withoutCharacterScopedTerms("blur, dark skin for Jaime", CAST, null)).toBe("blur");
  });

  it("leaves an ordinary term that merely contains 'for' alone", () => {
    expect(withoutCharacterScopedTerms("lit for daylight, blur", CAST, 3)).toBe(
      "lit for daylight, blur",
    );
  });

  it("does nothing without a cast to match against", () => {
    expect(withoutCharacterScopedTerms("dark skin for Jaime", [], 3)).toBe("dark skin for Jaime");
  });
});

/**
 * The agents write exclusions about build and lighting; nothing they produce is
 * ever aimed at the model drawing one person twice or growing a spare limb,
 * which is what a crowded or entangled shot actually does.
 */
describe("guarding a shot that holds more than one body", () => {
  it("adds the guards when the prompt states more than one person", () => {
    const guarded = withMultiSubjectGuards("blur", 3);
    expect(guarded).toContain("duplicated person");
    expect(guarded).toContain("cloned face");
    expect(guarded).toContain("extra limbs");
    expect(guarded).toContain("fused bodies");
    expect(guarded.startsWith("blur")).toBe(true);
  });

  /** On a single figure there is far less to catch, and a term with no work still pulls. */
  it("leaves a single-figure shot alone", () => {
    expect(withMultiSubjectGuards("blur", 1)).toBe("blur");
    expect(withMultiSubjectGuards("blur", null)).toBe("blur");
  });

  it("does not repeat a guard the scene already carries", () => {
    const guarded = withMultiSubjectGuards("blur, twins", 2);
    expect(guarded.match(/twins/g)).toHaveLength(1);
  });
});

/**
 * A description reading "no sharp edges" or "without a mouth" embeds the very
 * thing it rules out. A robot whose prompt said it had no mouth rendered with a
 * working one, which invalidated a prompt-format experiment before anyone
 * noticed why.
 */
describe("recovering a trait the positive prompt asked to be absent", () => {
  it("names it in the negative, where a sampler can act on it", () => {
    const negative = withNegatedTraits("blur", "a robot with no sharp angular edges");
    expect(negative).toContain("sharp angular edges");
    expect(negative).toContain("blur");
  });

  /** "no nose or mouth" is two traits; one run-on term suppresses neither well. */
  it("reads 'without' as well as 'no', and splits a pair", () => {
    const negative = withNegatedTraits("", "a face without a nose or mouth");
    expect(negative).toContain("nose");
    expect(negative).toContain("mouth");
    expect(negative).not.toContain("nose mouth");
  });

  it("skips words too general to suppress on their own", () => {
    expect(negatedTraitsIn("with no other")).toEqual([]);
  });

  it("leaves a prompt that states no absences alone", () => {
    expect(withNegatedTraits("blur, watermark", "a bright kitchen")).toBe("blur, watermark");
  });

  it("does not add a term the negative already carries", () => {
    const negative = withNegatedTraits("mouth", "a robot without a mouth");
    expect(negative.match(/mouth/g)).toHaveLength(1);
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

  /** Taken from a live catalogue listing, so a new release inherits the profile. */
  it("recognises the LTX 2.5 checkpoints", () => {
    expect(familyOf("ltx2_25_22B")).toBe("ltx");
    expect(familyOf("ltx2_25_22B_distilled")).toBe("ltx");
    expect(familyOf("ltx2_25_22B_distilled_nvfp4")).toBe("ltx");
  });

  it("prefers WanGP's own metadata when it has any", () => {
    expect(familyOf("some_variant", "ltx2")).toBe("ltx");
  });

  it("admits when it does not know", () => {
    expect(familyOf("hunyuan_video")).toBe("unknown");
    expect(familyOf(undefined)).toBe("unknown");
  });

  /**
   * The routing decision. FLUX and Krea have no dependable negative prompt, and
   * a live schema dump shows MiniMax H3 declares no such field at all; an
   * unknown model keeps one, because WanGP only sets fields a schema declares,
   * so an unusable negative is discarded harmlessly anyway.
   */
  it("withholds a negative prompt only from the families that discard it", () => {
    expect(supportsNegativePrompt("flux")).toBe(false);
    expect(supportsNegativePrompt("krea")).toBe(false);
    expect(supportsNegativePrompt("minimax")).toBe(false);
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

/**
 * LTX's published guide, which now covers 2.5 in the same document. The rules
 * that needed stating are the ones the general video directive gets wrong for
 * this family, plus the one capability 2.5 added.
 */
describe("what LTX is told, against its own prompting guide", () => {
  const directive = (segmentSeconds: number) =>
    videoPromptDirective("ltx", { segmentSeconds, nativeAudio: true });

  /**
   * 2.5 can cut between shots inside one generation. Every clip here opens on
   * a rendered keyframe and joins the next segment, and the guide says to stay
   * in one take for image-to-video from a first frame.
   */
  it("forbids the cuts LTX 2.5 is newly able to make", () => {
    const text = directive(8);
    expect(text).toMatch(/one continuous take/i);
    expect(text).toContain("hard cut");
    expect(text).toContain("dissolve");
  });

  /**
   * The general directive caps every family at one action plus one smaller
   * movement, which is Wan's formula. LTX asks for a sequence, so the cap has
   * to be lifted explicitly or the two instructions contradict each other.
   */
  it("lifts the general one-action limit and scales beats with length", () => {
    expect(directive(5)).toMatch(/at most one beat/);
    expect(directive(20)).toMatch(/at most 6 beats/);
    expect(directive(8)).toMatch(/supersedes the general limit/i);
  });

  it("asks for a chronological sequence rather than one isolated movement", () => {
    expect(directive(12)).toMatch(/chronological sequence/i);
  });

  /** Guide element 6: dialogue quoted, with language and accent where needed. */
  it("asks for the language and accent of a spoken line", () => {
    expect(directive(8)).toMatch(/language and the accent/i);
    expect(directive(8)).toMatch(/quotation marks/i);
  });

  /**
   * The model was told to aim at 2 words a second while the lint warned at
   * 2.5, so a prompt could be told it was under budget and flagged anyway.
   */
  it("quotes the same speech rate the lint enforces", () => {
    expect(directive(20)).toContain(`${Math.round(20 * WORDS_PER_SECOND)} words of speech`);
    expect(directive(20)).toContain("50 words of speech");
  });

  it("keeps the guide's other fundamentals", () => {
    const text = directive(8);
    expect(text).toMatch(/present tense/i);
    expect(text).toMatch(/four to eight sentences/i);
    expect(text).toMatch(/never through an emotional label/i);
  });
});

/**
 * A lineage that changed mid-life. Verified against live WanGP schemas:
 * `ltx2_22B_distilled_1_1` declares `negative_prompt`; every `ltx2_25_*`
 * checkpoint dropped it, so an exclusion routed on the family alone was
 * written into a manifest that discards the field.
 */
describe("whether an exclusion reaches the render", () => {
  it("passes it through where the checkpoint declares the field", () => {
    expect(negativePromptReaches("ltx", true)).toBe(true);
    expect(negativePromptReaches("wan", true)).toBe(true);
  });

  it("withholds it from an LTX checkpoint that dropped the field", () => {
    expect(negativePromptReaches("ltx", false)).toBe(false);
  });

  /** Nothing has read a schema, so the family's answer stands. */
  it("keeps the family's answer when the schema is unknown", () => {
    expect(negativePromptReaches("ltx", undefined)).toBe(true);
    expect(negativePromptReaches("flux", undefined)).toBe(false);
  });

  /** FLUX declares the field and ignores it, so a schema must not re-enable it. */
  it("never lets a schema grant a negative the family ignores", () => {
    expect(negativePromptReaches("flux", true)).toBe(false);
    expect(negativePromptReaches("krea", true)).toBe(false);
    expect(negativePromptReaches("minimax", true)).toBe(false);
  });
});
