import { describe, it, expect } from "vitest";
import {
  missingDialogue,
  normaliseImagePrompt,
  normaliseVideoPrompt,
  opensWithFraming,
} from "@/lib/agents/media-prompt-normalise";
import type { MediaPromptSpec } from "@/lib/agents/media-prompt-spec";

const spec: MediaPromptSpec = {
  framing: { shotSize: "Close-up", cameraHeight: "low angle" },
  subject: "The apprentice",
  setting: "a workshop",
  lighting: "low sun",
  startState: "gear held clear",
  endState: "gear seated",
  dominantMotion: "she seats the gear",
  cameraMotion: "pushes in",
  dialogue: [],
  continuity: [],
  exclusions: [],
};

describe("detecting a framing-first opening", () => {
  it("accepts an opening with both shot size and height", () => {
    expect(opensWithFraming("Extreme close-up, eye level, on the gear.")).toBe(true);
  });

  it("rejects a shot size with no camera height", () => {
    expect(opensWithFraming("Extreme close-up on the gear.")).toBe(false);
  });

  it("rejects framing buried past the opening", () => {
    const buried = `${"word ".repeat(40)}medium shot, eye level.`;
    expect(opensWithFraming(buried)).toBe(false);
  });
});

/**
 * The system prompt already asks for framing-first openings, but asking is not
 * getting: a model that drops the shot size recreates the exact defect the
 * deterministic path was fixed for.
 */
describe("normalising a model-authored image prompt", () => {
  it("prepends the derived framing when the model omitted it", () => {
    const result = normaliseImagePrompt("The apprentice leans over the bench.", spec, "flux");
    expect(result.framingRepaired).toBe(true);
    expect(result.text.startsWith("Close-up, low angle.")).toBe(true);
  });

  it("leaves a well-formed opening untouched", () => {
    const good = "Wide shot, high angle, of the workshop floor.";
    const result = normaliseImagePrompt(good, spec, "flux");
    expect(result.framingRepaired).toBe(false);
    expect(result.text).toBe(good);
  });

  it("keeps the model's own words rather than rewriting them", () => {
    const result = normaliseImagePrompt("A brass gear catches the last of the light.", spec, "flux");
    expect(result.text).toContain("catches the last of the light");
  });

  it("removes a repeated sentence the model emitted", () => {
    const result = normaliseImagePrompt(
      "Close-up, eye level. The gear turns. The gear turns.",
      spec,
      "flux",
    );
    expect(result.text.match(/gear turns/g)?.length).toBe(1);
  });

  it("repairs punctuation artifacts and reports none remaining", () => {
    const result = normaliseImagePrompt("Close-up, eye level. The gear ., turns.", spec, "flux");
    expect(result.findings.map((f) => f.code)).not.toContain("punctuation_artifact");
  });
});

describe("normalising a model-authored video prompt", () => {
  it("does not force framing, since the start frame already fixes it", () => {
    const result = normaliseVideoPrompt("She seats the gear as the scarf lifts.", "wan", 5);
    expect(result.framingRepaired).toBe(false);
    expect(result.text.startsWith("She seats the gear")).toBe(true);
  });

  it("reports going over the family budget without truncating the text", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ") + ".";
    const result = normaliseVideoPrompt(long, "wan", 5);
    expect(result.findings.map((f) => f.code)).toContain("over_budget");
    expect(result.text).toContain("w199");
  });

  it("keeps quoted dialogue intact through cleaning", () => {
    const text = 'She turns. Ana says, "Then we decide now." Lip movement matches.';
    expect(normaliseVideoPrompt(text, "ltx", 10).text).toContain('"Then we decide now."');
  });
});

/**
 * Dialogue is what the video model speaks, so anything summarised away is not
 * heard. Comparing against the card is the only way to notice.
 */
describe("detecting dropped dialogue", () => {
  it("finds a line the model left out", () => {
    const missing = missingDialogue('Ana says, "Now."', [
      { line: "Now." },
      { line: "Then we decide." },
    ]);
    expect(missing).toEqual(["Then we decide."]);
  });

  it("matches regardless of quote style", () => {
    expect(missingDialogue('Ana says, “Now.”', [{ line: "Now." }])).toEqual([]);
  });

  it("reports nothing when every line survived", () => {
    const text = 'Ana says, "Now." Ben says, "Not yet."';
    expect(missingDialogue(text, [{ line: "Now." }, { line: "Not yet." }])).toEqual([]);
  });
});
