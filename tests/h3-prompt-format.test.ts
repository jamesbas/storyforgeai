import { describe, it, expect } from "vitest";
import {
  h3Mode,
  h3AlignmentHeader,
  renderH3Prompt,
  isH3Prompt,
  stripH3Envelope,
  usesH3PromptFormat,
} from "@/lib/agents/h3-prompt";

/**
 * MiniMax H3's native prompt envelope.
 *
 * The wording of the alignment line and the three field labels are fixed by
 * MiniMax's own VIDEO_PROMPT_WRITING_GUIDE, not chosen here, so these tests
 * pin them verbatim: a paraphrase is a different instruction to the model.
 */

describe("which mode the supplied keyframes put H3 in", () => {
  it("reads the mode off the frames", () => {
    expect(h3Mode(true, true)).toBe("fl2va");
    expect(h3Mode(true, false)).toBe("i2va");
    expect(h3Mode(false, true)).toBe("l2va");
    expect(h3Mode(false, false)).toBe("t2va");
  });
});

describe("the alignment instruction", () => {
  it("places both frames for a first-and-last-frame clip", () => {
    const header = h3AlignmentHeader("fl2va", 15);
    expect(header).toBe(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) " +
        "aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot 1]) aligns with the " +
        "15.00-second mark of the target video.",
    );
  });

  it("anchors only the opening when there is no end frame", () => {
    expect(h3AlignmentHeader("i2va", 15)).toContain("at 0.00 seconds into the target video");
  });

  it("anchors only the close when there is no start frame", () => {
    expect(h3AlignmentHeader("l2va", 6)).toContain("6.00-second mark");
  });

  it("has nothing to say when no frame was supplied", () => {
    expect(h3AlignmentHeader("t2va", 15)).toBe("");
  });

  it("formats every timestamp to two decimals", () => {
    expect(h3AlignmentHeader("fl2va", 7.5)).toContain("7.50-second mark");
    expect(h3AlignmentHeader("l2va", 20)).toContain("20.00-second mark");
  });
});

describe("the envelope", () => {
  const parts = {
    body: "A keeper crosses the gantry as the lamp turns behind him.",
    soundscape: "Wind pushes against the glass and his boots ring on the steel.",
    score: "Low sustained strings at a slow tempo, fading at the end.",
    durationSeconds: 15,
    hasStart: true,
    hasEnd: true,
  };

  it("keeps the instruction and all three fields in one sliding-window paragraph", () => {
    const prompt = renderH3Prompt(parts);
    const lines = prompt.split("\n");
    expect(lines[0]).toContain("How the reference pictures align");
    expect(lines[1]).toMatch(/^integrated_multimodal_description: \[Shot 1\] A keeper/);
    expect(lines[2]).toMatch(/^overall_soundscape: Wind pushes/);
    expect(lines[3]).toMatch(/^non_diegetic_music: Low sustained/);
    expect(prompt).not.toContain("\n\n");
  });

  it("marks the single shot, and does not mark it twice", () => {
    expect(renderH3Prompt({ ...parts, body: "[Shot 1] Already marked." })).toContain(
      "integrated_multimodal_description: [Shot 1] Already marked.",
    );
    expect(renderH3Prompt({ ...parts, body: "[Shot 1] Already marked." })).not.toContain(
      "[Shot 1] [Shot 1]",
    );
  });

  /** The guide uses N/A for an absent layer rather than dropping the field. */
  it("writes N/A for a layer the scene does not have", () => {
    const prompt = renderH3Prompt({ ...parts, soundscape: undefined, score: "   " });
    expect(prompt).toContain("overall_soundscape: N/A");
    expect(prompt).toContain("non_diegetic_music: N/A");
  });

  it("omits the instruction entirely when no frame is supplied", () => {
    const prompt = renderH3Prompt({ ...parts, hasStart: false, hasEnd: false });
    expect(prompt.startsWith("integrated_multimodal_description:")).toBe(true);
  });

  it("names a supplied source video as the continuation state", () => {
    const prompt = renderH3Prompt({
      ...parts,
      hasStart: false,
      hasEnd: false,
      hasVideoSource: true,
    });
    expect(prompt).toContain("[Shot 1] Continue directly from <Video 1>'s final frame");
    expect(prompt).toContain("synchronized audio without a reset");
  });
});

/**
 * A prompt is written for the pinned model, but a missing pin falls through to
 * the router — so the family that renders is not always the family the prompt
 * was written for. Handing these labels to a Wan model would render the words.
 */
describe("recovering the prose when something else renders it", () => {
  const prompt = renderH3Prompt({
    body: "She lifts the umbrella as the camera pulls out at slow speed.",
    soundscape: "Rain falls steadily on the pavement.",
    score: "N/A",
    durationSeconds: 8,
    hasStart: true,
    hasEnd: true,
  });

  it("recognises its own envelope", () => {
    expect(isH3Prompt(prompt)).toBe(true);
    expect(isH3Prompt("A plain prose prompt.")).toBe(false);
  });

  it("strips the labels and the shot marker", () => {
    const stripped = stripH3Envelope(prompt);
    expect(stripped).not.toContain("integrated_multimodal_description");
    expect(stripped).not.toContain("overall_soundscape");
    expect(stripped).not.toContain("[Shot 1]");
    expect(stripped).toContain("She lifts the umbrella");
  });

  it("keeps the audio direction, which is still direction without the labels", () => {
    expect(stripH3Envelope(prompt)).toContain("Rain falls steadily");
  });

  it("drops an N/A layer rather than saying it out loud", () => {
    expect(stripH3Envelope(prompt)).not.toContain("N/A");
  });

  it("leaves a prompt that was never in the envelope untouched", () => {
    expect(stripH3Envelope("A plain prose prompt.")).toBe("A plain prose prompt.");
  });
});

describe("who gets the envelope", () => {
  it("is MiniMax and nothing else", () => {
    expect(usesH3PromptFormat("minimax")).toBe(true);
    for (const family of ["ltx", "wan", "flux", "qwen", "krea", "unknown"] as const) {
      expect(usesH3PromptFormat(family)).toBe(false);
    }
  });
});

/**
 * A live clip whose prompt read `The robot says, "..."` inside the envelope came
 * back with no speech in it at all, while the same line in loose prose was at
 * least sung. Only `<d>` content is uttered.
 */
describe("spoken lines", () => {
  const spoken = {
    body: 'The robot says, "The sky is right there."',
    durationSeconds: 15,
    hasStart: true,
    hasEnd: true,
  };

  it("tags the words, and leaves the speaker and verb outside the tag", () => {
    const prompt = renderH3Prompt(spoken);
    expect(prompt).toContain('(S1) says: <d>[English] The sky is right there.</d>');
    expect(prompt).not.toContain('"The sky is right there."');
  });

  it("numbers each speaker in the order they first talk", () => {
    const prompt = renderH3Prompt({
      ...spoken,
      body: 'Ana says, "Now." The keeper said "Not yet."',
    });
    expect(prompt).toContain("(S1) says: <d>[English] Now.</d>");
    expect(prompt).toContain("(S2) said: <d>[English] Not yet.</d>");
  });

  it("never rewrites a prompt that already carries markup", () => {
    const already = 'Ana (S1) says: <d>[English] Now.</d> A sign reads "OPEN".';
    expect(renderH3Prompt({ ...spoken, body: already })).toContain('A sign reads "OPEN".');
  });

  it("leaves quotes that are not speech alone", () => {
    const prompt = renderH3Prompt({ ...spoken, body: 'A neon sign reads "OPEN" above the door.' });
    expect(prompt).toContain('"OPEN"');
    expect(prompt).not.toContain("<d>");
  });

  it("puts the words back in plain quotes for anything that is not H3", () => {
    const stripped = stripH3Envelope(renderH3Prompt(spoken));
    expect(stripped).toContain('"The sky is right there."');
    expect(stripped).not.toContain("<d>");
    expect(stripped).not.toContain("[English]");
  });
});
