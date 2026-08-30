import { describe, expect, it } from "vitest";
import { renderH3Prompt, withoutBlankLines } from "@/lib/agents/h3-prompt";
import { renderH3ReferencePrompt } from "@/lib/agents/h3-reference-prompt";

/**
 * Wan2GP's prompt box states the rule outright: "each Paragraph of Prompt
 * separated by an Empty Line will generate a new Video". So a blank line inside
 * one scene's prompt does not merely confuse the model, it asks for a second
 * video. Single breaks are safe and are what the H3 guides ask for, since the
 * labelled fields sit on their own lines.
 */
const envelope = {
  body: 'Ana says, "We should go." She walks to the door.',
  soundscape: "Rain on glass.",
  score: "Low strings.",
  durationSeconds: 20,
  hasStart: true,
  hasEnd: true,
};

const reference = {
  body: 'Ana says, "We should go." She walks to the door.',
  subjects: [{ name: "Ana", description: "Dark coat.", pictureIndex: 3 }],
  hasStart: true,
  hasEnd: true,
  soundscape: "Rain on glass.",
  score: "Low strings.",
};

describe("blank lines in an H3 prompt", () => {
  it("collapses a blank line without joining the surrounding lines", () => {
    expect(withoutBlankLines("a\n\nb")).toBe("a\nb");
    expect(withoutBlankLines("a\n   \n\t\nb")).toBe("a\nb");
    expect(withoutBlankLines("a\r\n\r\nb")).toBe("a\nb");
    // The fields are meant to be on separate lines, so a single break stays.
    expect(withoutBlankLines("a\nb")).toBe("a\nb");
  });

  it("never leaves one in either H3 format", () => {
    expect(renderH3Prompt(envelope)).not.toMatch(/\n\s*\n/);
    expect(renderH3ReferencePrompt(reference)).not.toMatch(/\n\s*\n/);
  });

  it("survives a caller whose text carries its own blank line", () => {
    const paragraphs = "She turns.\n\nShe walks to the door.";

    expect(renderH3Prompt({ ...envelope, body: paragraphs })).not.toMatch(/\n\s*\n/);
    expect(renderH3ReferencePrompt({ ...reference, body: paragraphs })).not.toMatch(/\n\s*\n/);
  });

  /** A leading `#` is a comment to Wan2GP and a leading `!` is a macro. */
  it("starts every line with the field label or its content", () => {
    for (const prompt of [renderH3Prompt(envelope), renderH3ReferencePrompt(reference)]) {
      for (const line of prompt.split("\n")) {
        expect(line.trimStart()).not.toMatch(/^[#!]/);
      }
    }
  });
});
