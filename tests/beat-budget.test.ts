import { describe, it, expect } from "vitest";
import { beatBudget, countImpliedBeats, denouementBudget } from "@/lib/agents/beat-budget";
import { storyArchitectSystem } from "@/lib/agents/story-architect-agent";

/**
 * Pacing: whether the runtime can hold the story, and what to do when it cannot.
 *
 * Scene length is fixed and the scene count is the runtime divided by it, so
 * nothing downstream can make room. A brief describing more actions than there
 * are scenes gets compressed, and the compression is invisible — it lands
 * wherever the model yields, which is reliably the middle, leaving the tail to
 * be padded with aftermath.
 */

describe("counting the actions a brief describes", () => {
  it("counts sentences as separate actions", () => {
    expect(
      countImpliedBeats(
        "A courier collects a package. She crosses the city on foot. She hands it to a stranger.",
      ),
    ).toBe(3);
  });

  it("counts clauses joined by a sequencing word", () => {
    expect(
      countImpliedBeats("She picks the lock, then slips inside, and finally opens the safe"),
    ).toBe(3);
  });

  it("does not treat a plain 'and' as a new action", () => {
    // "and" joins objects and adjectives far more often than events; counting it
    // turned every descriptive sentence into three beats.
    expect(countImpliedBeats("A tall woman in a red and grey coat waits with a dog and a suitcase")).toBe(1);
  });

  it("ignores fragments too short to be an action", () => {
    expect(countImpliedBeats("She runs. Yes. No. He follows her through the market.")).toBe(2);
  });
});

describe("warning that the runtime cannot hold the brief", () => {
  const concept =
    "A locksmith opens the shop. A stranger asks for a copy of an unusual key. " +
    "The locksmith recognises it. He follows the stranger across town. " +
    "He watches the door the key belongs to. Then he calls the police.";

  it("reports the shortfall and the runtime that would fit", () => {
    const budget = beatBudget({
      concept,
      requestedDurationSeconds: 60,
      segmentSeconds: 20,
    })!;

    expect(budget.impliedBeats).toBe(6);
    expect(budget.availableScenes).toBe(3);
    expect(budget.suggestedDurationSeconds).toBe(120);
  });

  it("stays quiet when the brief fits the runtime", () => {
    expect(beatBudget({ concept, requestedDurationSeconds: 120, segmentSeconds: 20 })).toBeNull();
  });

  it("stays quiet when there is room to spare", () => {
    expect(beatBudget({ concept, requestedDurationSeconds: 300, segmentSeconds: 20 })).toBeNull();
  });

  it("has no opinion on an empty concept", () => {
    expect(beatBudget({ concept: "   ", requestedDurationSeconds: 60, segmentSeconds: 20 })).toBeNull();
  });

  it("accounts for clip length, not just runtime", () => {
    // The same runtime holds far more scenes at 5s per clip than at 20s.
    const short = beatBudget({ concept, requestedDurationSeconds: 60, segmentSeconds: 5 });
    expect(short).toBeNull();
  });
});

describe("the aftermath budget", () => {
  it("allows one closing scene for a short piece and two for a long one", () => {
    expect(denouementBudget(3)).toBe(1);
    expect(denouementBudget(6)).toBe(1);
    expect(denouementBudget(20)).toBe(2);
  });
});

describe("what the Story Architect is told", () => {
  it("tells it to spend extra segments on an action rather than compress it", () => {
    const system = storyArchitectSystem(20, 12);
    expect(system).toContain("continuedSegments");
    expect(system).toMatch(/several consecutive segments/i);
  });

  it("caps the aftermath and says to spend the freed segments earlier", () => {
    expect(storyArchitectSystem(20, 12)).toMatch(/at most 2 of the final beats may be aftermath/i);
    expect(storyArchitectSystem(20, 6)).toMatch(/at most 1 of the final beats may be aftermath/i);
  });

  it("leaves a two-segment piece alone, having no tail worth capping", () => {
    expect(storyArchitectSystem(20, 2)).not.toMatch(/aftermath/i);
  });

  it("scales the sustained-action wording to the project's clip length", () => {
    expect(storyArchitectSystem(8, 6)).toContain("8 seconds");
  });
});
