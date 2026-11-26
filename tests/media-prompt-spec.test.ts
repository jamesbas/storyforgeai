import { describe, it, expect } from "vitest";
import {
  cleanPunctuation,
  countSpokenWords,
  countWords,
  dedupeSentences,
  dialogueWordBudget,
  dialogueWordTargets,
  effectiveSpeechSeconds,
  inferDialogueMode,
  lintDialogue,
  hasBlockingFinding,
  hasPunctuationArtifact,
  lintImageSpec,
  lintRendered,
  lintVideoSpec,
  sceneSpeechTargets,
  splitSentences,
  visualWordCount,
  wordBudget,
  type MediaPromptSpec,
} from "@/lib/agents/media-prompt-spec";

function spec(overrides: Partial<MediaPromptSpec> = {}): MediaPromptSpec {
  return {
    framing: { shotSize: "Medium shot", cameraHeight: "eye level" },
    subject: "The apprentice braces a brass gear",
    setting: "a cluttered clock workshop",
    lighting: "low winter sun through a dusty window",
    startState: "the gear held clear of the movement",
    endState: "the gear seated, teeth meshed",
    dominantMotion: "she seats the gear with a firm clockwise turn",
    cameraMotion: "one slow push-in",
    dialogue: [],
    continuity: [],
    exclusions: [],
    ...overrides,
  };
}

describe("sentence handling", () => {
  it("splits on terminators and keeps them", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("counts words without being fooled by extra spacing", () => {
    expect(countWords("  one   two  three ")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });
});

/**
 * The old builders pasted `visualDescription` into the start frame, the end
 * frame and the video prompt, then appended plan text that restated it again.
 */
describe("duplicate removal", () => {
  it("drops a repeated sentence and keeps the first", () => {
    const text = "The gear turns. The room is cold. The gear turns.";
    expect(dedupeSentences(text)).toBe("The gear turns. The room is cold.");
  });

  it("ignores case, trailing punctuation and quote style when comparing", () => {
    expect(dedupeSentences("Advance beat two. advance beat two!")).toBe("Advance beat two.");
  });

  it("never drops a line containing quoted speech", () => {
    // Two characters may legitimately say the same words, and dialogue is verbatim.
    const text = 'Ana says, "Now." Ben says, "Now."';
    expect(dedupeSentences(text)).toBe(text);
  });

  it("leaves distinct sentences alone", () => {
    const text = "She turns the gear. He watches the door.";
    expect(dedupeSentences(text)).toBe(text);
  });
});

describe("punctuation repair", () => {
  it("fixes the artifact concatenation actually produced", () => {
    // Real trace: `Camera: ${cameraMovement.toLowerCase()}, evolving...` where
    // the field already ended in a full stop.
    const broken = "Camera: slow push-in on the subject., evolving from the start frame.";
    expect(cleanPunctuation(broken)).toBe(
      "Camera: slow push-in on the subject. evolving from the start frame.",
    );
  });

  it("removes a space before punctuation", () => {
    expect(cleanPunctuation("the gear , seated .")).toBe("the gear, seated.");
  });

  it("collapses doubled terminators and separators", () => {
    expect(cleanPunctuation("Wait.. Then go,, now")).toBe("Wait. Then go, now");
  });

  it("drops an empty parenthetical left by a missing value", () => {
    expect(cleanPunctuation("Lens ( ) on the subject")).toBe("Lens on the subject");
  });

  it("detects every artifact it repairs", () => {
    for (const broken of ["a., b", "a ,b", "a,, b", "a.. b", "a ( ) b"]) {
      expect(hasPunctuationArtifact(broken), broken).toBe(true);
    }
    expect(hasPunctuationArtifact("A clean sentence, with a clause.")).toBe(false);
  });
});

describe("image spec requirements", () => {
  it("accepts a complete spec", () => {
    expect(lintImageSpec(spec())).toEqual([]);
  });

  it("blocks when shot size is missing", () => {
    const findings = lintImageSpec(spec({ framing: { shotSize: "", cameraHeight: "eye level" } }));
    expect(findings.map((f) => f.code)).toContain("missing_shot_size");
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it("blocks when camera height is missing", () => {
    const findings = lintImageSpec(spec({ framing: { shotSize: "Wide shot", cameraHeight: " " } }));
    expect(findings.map((f) => f.code)).toContain("missing_camera_height");
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it("warns but does not block on missing lighting or setting", () => {
    const findings = lintImageSpec(spec({ lighting: "", setting: "" }));
    expect(findings.map((f) => f.code).sort()).toEqual(["missing_lighting", "missing_setting"]);
    expect(hasBlockingFinding(findings)).toBe(false);
  });
});

describe("video spec requirements", () => {
  it("accepts a complete spec", () => {
    expect(lintVideoSpec(spec(), 5)).toEqual([]);
  });

  it("blocks when no dominant action is stated", () => {
    const findings = lintVideoSpec(spec({ dominantMotion: "" }), 5);
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it("warns when the camera behaviour is unstated", () => {
    const findings = lintVideoSpec(spec({ cameraMotion: "" }), 5);
    expect(findings.find((f) => f.code === "missing_camera_behavior")?.severity).toBe("warning");
  });
});

describe("dialogue duration budget", () => {
  it("scales with the segment", () => {
    expect(dialogueWordBudget(5)).toBe(13);
    expect(dialogueWordBudget(10)).toBe(25);
    expect(dialogueWordBudget(20)).toBe(50);
  });

  it("passes a line that fits five seconds", () => {
    const findings = lintVideoSpec(
      spec({ dialogue: [{ speaker: "Ana", line: "Then we decide now, before the clock stops." }] }),
      5,
    );
    expect(findings).toEqual([]);
  });

  it("warns rather than blocks when a line overruns, because dialogue is authoritative", () => {
    const long = Array.from({ length: 40 }, () => "word").join(" ");
    const findings = lintVideoSpec(spec({ dialogue: [{ speaker: "Ana", line: long }] }), 5);
    const finding = findings.find((f) => f.code === "dialogue_over_budget");
    expect(finding?.severity).toBe("warning");
    expect(hasBlockingFinding(findings)).toBe(false);
  });

  it("warns below the full-scene floor without blocking or changing the script", () => {
    const dialogue = [{ line: Array.from({ length: 29 }, () => "word").join(" ") }];
    const original = structuredClone(dialogue);
    const findings = lintDialogue(dialogue, 20);
    expect(findings).toMatchObject([{ code: "dialogue_under_budget", severity: "warning" }]);
    expect(findings[0]!.message).toContain("Aim for 34-42 words, at least 30");
    expect(findings[0]!.message).toContain("not measured audio");
    expect(hasBlockingFinding(findings)).toBe(false);
    expect(dialogue).toEqual(original);
  });

  it("accepts the exact floor and preserves intentionally silent scenes", () => {
    expect(lintDialogue([{ line: Array.from({ length: 30 }, () => "word").join(" ") }], 20)).toEqual([]);
    expect(lintDialogue([], 20)).toEqual([]);
    // A line with no words reads as a silent scene, exactly as an empty list does.
    expect(lintDialogue([{ line: "" }], 20)).toEqual([]);
    expect(lintDialogue([{ line: "" }], 20, { mode: "full" })[0]?.code).toBe("dialogue_under_budget");
  });

  it.each([1, 5, 10, 14, 20, 30])("keeps targets within the capacity of a %is scene", (seconds) => {
    for (const mode of ["full", "brief"] as const) {
      const targets = dialogueWordTargets(seconds, mode);
      expect(targets.minimum).toBeLessThanOrEqual(targets.targetMin);
      expect(targets.targetMin).toBeLessThanOrEqual(targets.targetMax);
      expect(targets.targetMax).toBeLessThanOrEqual(targets.maximum);
      expect(targets.maximum).toBeLessThanOrEqual(dialogueWordBudget(seconds));
    }
  });
});

describe("dialogue modes", () => {
  const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

  it("asks a full scene to fill most of the clip and a brief one for a line", () => {
    expect(dialogueWordTargets(20, "full")).toEqual({ minimum: 30, targetMin: 34, targetMax: 42, maximum: 50 });
    expect(dialogueWordTargets(10, "full")).toEqual({ minimum: 15, targetMin: 17, targetMax: 21, maximum: 25 });
    expect(dialogueWordTargets(20, "brief")).toEqual({ minimum: 1, targetMin: 6, targetMax: 18, maximum: 23 });
    expect(dialogueWordTargets(10, "brief")).toEqual({ minimum: 1, targetMin: 3, targetMax: 10, maximum: 15 });
    expect(dialogueWordTargets(20, "silent")).toEqual({ minimum: 0, targetMin: 0, targetMax: 0, maximum: 0 });
  });

  it("never counts a stage direction as speech", () => {
    expect(countSpokenWords([
      { line: "(whispers) Get down." },
      { line: "[sighs]" },
      { line: "*laughs* Not a chance." },
    ])).toBe(5);
  });

  it("gives voice-over its share of the clip", () => {
    const narrationText = words(25);
    expect(effectiveSpeechSeconds(20, narrationText)).toBe(10);
    const targets = sceneSpeechTargets([{ line: "x" }], 20, { mode: "full", narrationText });
    expect(targets).toMatchObject({ effectiveSeconds: 10, minimum: 15, maximum: 25 });
    const [finding] = lintDialogue([{ line: words(30) }], 20, { mode: "full", narrationText });
    expect(finding?.code).toBe("dialogue_over_budget");
    expect(finding?.message).toContain("10.0s of voice-over");
  });

  it("writes a full scene squeezed by voice-over to brief targets", () => {
    const targets = sceneSpeechTargets([], 5, { mode: "full", narrationText: words(5) });
    expect(targets.targetMode).toBe("brief");
    expect(lintDialogue([{ line: "Hold it." }], 5, { mode: "full", narrationText: words(5) })).toEqual([]);
  });

  it("never asks a brief scene to pad, and flags lines in a silent one", () => {
    expect(lintDialogue([{ line: "Down, now!" }], 20, { mode: "brief" })).toEqual([]);
    expect(lintDialogue([], 20, { mode: "brief" })[0]?.code).toBe("dialogue_under_budget");
    expect(lintDialogue([{ line: words(24) }], 20, { mode: "brief" })[0]?.code).toBe("dialogue_over_budget");
    expect(lintDialogue([{ line: "Hello." }], 20, { mode: "silent" })).toMatchObject([
      { code: "dialogue_in_silent_scene", severity: "warning" },
    ]);
  });

  it("reads a scene with no stored mode from its lines", () => {
    expect(inferDialogueMode([])).toBe("silent");
    expect(inferDialogueMode([{ line: "(nods)" }])).toBe("silent");
    expect(inferDialogueMode([{ line: "Go." }])).toBe("full");
    expect(inferDialogueMode([{ line: "Go." }], "brief")).toBe("brief");
  });
});

describe("visual words in a multi-turn video prompt", () => {
  it("excludes speech however it is attributed, but still counts signage", () => {
    const prose = "Ana leans over the table.";
    // The attribution itself is prose; only the quoted words are speech.
    expect(visualWordCount(`${prose} Ana murmurs, "Not here." Ben pleads, "Please, just once."`)).toBe(9);
    expect(visualWordCount(`${prose} Ana: "Not here."`)).toBe(6);
    expect(visualWordCount(`${prose} "Not here," Ana snaps.`)).toBe(7);
    expect(visualWordCount(`${prose} A neon sign reading "OPEN" flickers.`)).toBe(11);
  });

  it("excludes a quoted scene line even with no speech verb", () => {
    const text = 'Ana holds his gaze, jaw tight, "You were never here."';
    expect(visualWordCount(text, [{ line: "You were never here." }])).toBe(6);
    expect(visualWordCount(text)).toBe(10);
  });
});

describe("family word budgets", () => {
  it("keeps Wan tightest, since its formula is motion plus camera and nothing else", () => {
    expect(wordBudget("wan", "video", 5)).toBeLessThan(wordBudget("ltx", "video", 5));
  });

  it("gives LTX room for speech, which it renders from the same text", () => {
    expect(wordBudget("ltx", "video", 20)).toBeGreaterThan(wordBudget("ltx", "video", 5));
  });

  it("does not pace image families by duration", () => {
    expect(wordBudget("flux", "image", 5)).toBe(wordBudget("flux", "image", 20));
  });
});

describe("rendered-string lint", () => {
  it("passes a clean prompt", () => {
    expect(lintRendered("Medium shot, eye level. She turns the gear.", "wan", "video", 5)).toEqual(
      [],
    );
  });

  it("reports a repeated sentence", () => {
    const findings = lintRendered("She turns. She turns.", "wan", "video", 5);
    expect(findings.map((f) => f.code)).toContain("duplicate_sentence");
  });

  it("reports a punctuation artifact", () => {
    const findings = lintRendered("Camera: push-in., then hold.", "wan", "video", 5);
    expect(findings.map((f) => f.code)).toContain("punctuation_artifact");
  });

  it("reports going over the family budget", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    expect(lintRendered(long, "wan", "video", 5).map((f) => f.code)).toContain("over_budget");
  });
});
