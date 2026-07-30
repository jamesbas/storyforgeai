import { describe, it, expect } from "vitest";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";

/**
 * The deterministic storyboard fallback.
 *
 * This runs whenever the Storyboard Agent's response fails validation, and it
 * is the only thing standing between a failed LLM call and no storyboard at
 * all. It used to paste the entire project concept into every scene's visual
 * description, so a fifteen-scene storyboard came back with fifteen cards that
 * read identically — indistinguishable from a storage bug, and it buried the
 * one line that actually described the shot.
 */

const CONCEPT =
  "A lighthouse keeper argues with his adult daughter about leaving the island. " +
  "She has packed. He has not. The storm outside is the least of it.";

const project = (segmentCount: number): Project =>
  ({
    id: "p1",
    title: "T",
    concept: CONCEPT,
    requestedDurationSeconds: segmentCount * 20,
    segmentSeconds: 20,
    segmentCount,
    generatedDurationSeconds: segmentCount * 20,
    finalTrimSeconds: 0,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "tense",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "video_segments",
    modelStrategy: "auto",
    useCharacterLibrary: false,
    characterIds: [],
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as Project;

/** A plan whose beats are real, as the Story Architect produces even when the
 * Storyboard Agent later fails. */
const storyPlan = (beats: string[]): StoryPlan => ({
  projectId: "p1",
  title: "T",
  logline: "A keeper and his daughter.",
  emotionalProgression: beats.map(() => "rising tension"),
  segmentBeats: beats,
});

const BEATS = [
  "Wide shot of the lamp room; the keeper trims the wick as rain hammers the glass.",
  "The daughter drags a packed case down the spiral stair.",
  "They face each other across the kitchen table and neither speaks.",
];

const brief = {} as CreativeBrief;
const bible = {} as VisualBible;

function drafts(beats = BEATS) {
  return buildSceneDrafts(project(beats.length), storyPlan(beats), brief, bible);
}

describe("scene drafts", () => {
  it("gives every scene its own visual description", () => {
    const unique = new Set(drafts().map((d) => d.visualDescription));
    expect(unique.size).toBe(BEATS.length);
  });

  /**
   * The real regression: two descriptions that differ only in a trailing clause
   * still read as identical on screen. The shared tail must be a small part of
   * the whole, not 1375 characters of it.
   */
  it("does not lead every scene with the same block of text", () => {
    const [first, , third] = drafts();
    let shared = 0;
    while (
      shared < Math.min(first!.visualDescription.length, third!.visualDescription.length) &&
      first!.visualDescription[shared] === third!.visualDescription[shared]
    ) {
      shared += 1;
    }
    expect(shared).toBeLessThan(40);
  });

  it("carries the scene's own beat into the description and the action", () => {
    const [, second] = drafts();
    expect(second!.visualDescription).toContain("packed case");
    expect(second!.actionDescription).toContain("packed case");
  });

  /** The setting still has to survive, or a fallback storyboard loses its world. */
  it("keeps a short excerpt of the concept, not the whole thing", () => {
    const [first] = drafts();
    expect(first!.visualDescription).toContain("lighthouse keeper");
    expect(first!.visualDescription).not.toContain(CONCEPT);
  });

  it("titles scenes from their beat rather than numbering them", () => {
    const titles = drafts().map((d) => d.title);
    expect(titles).not.toContain("Scene 1");
    expect(new Set(titles).size).toBe(BEATS.length);
  });

  /** With no usable beat there is nothing to name a scene after. */
  it("falls back to a numbered title when the beat is empty", () => {
    const [first] = buildSceneDrafts(project(1), storyPlan([""]), brief, bible);
    expect(first!.title).toBe("Scene 1");
  });
});
