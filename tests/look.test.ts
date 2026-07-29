import { describe, it, expect } from "vitest";
import { creativeModeDirective, lookPromptSuffix } from "@/lib/agents/look";
import type { Project } from "@/lib/schemas/project";

/**
 * The look reaching the render.
 *
 * Style and tone used to travel only inside the `project` JSON handed to the
 * planning agents, so whether they reached a render prompt was up to the model.
 * In one storyboard scene 3 said "moody and cinematic" and scene 1 said nothing
 * at all — the same project, two different looks.
 */

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    title: "T",
    concept: "c",
    requestedDurationSeconds: 40,
    segmentSeconds: 20,
    segmentCount: 2,
    generatedDurationSeconds: 40,
    finalTrimSeconds: 0,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "film noir",
    tone: "gritty",
    audience: "adults only, explicit content",
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
    ...over,
  }) as Project;

describe("look suffix", () => {
  it("states style, tone and audience", () => {
    const suffix = lookPromptSuffix(project(), "A wide shot of a bar.");

    expect(suffix).toContain("film noir style");
    expect(suffix).toContain("gritty mood");
    expect(suffix).toContain("Intended audience: adults only, explicit content.");
  });

  /**
   * A duplicated term in a diffusion prompt carries double the weight, so
   * anything the model already said is left alone.
   */
  it("does not repeat what the prompt already says", () => {
    const suffix = lookPromptSuffix(project(), "A film noir frame, gritty and unlit.");

    expect(suffix).not.toContain("film noir style");
    expect(suffix).not.toContain("gritty mood");
  });

  it("says nothing when there is nothing to add", () => {
    const bare = project({ style: "cinematic", tone: "calm", audience: undefined });
    expect(lookPromptSuffix(bare, "A cinematic, calm frame.")).toBe("");
  });
});

describe("creative mode directive", () => {
  it("names the format and its conventions", () => {
    const directive = creativeModeDirective(project({ creativeMode: "shorts_reels_tiktok" }));

    expect(directive).toContain("shorts reels tiktok");
    expect(directive).toContain("Hook inside the first second");
  });
});
