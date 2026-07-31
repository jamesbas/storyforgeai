import { describe, it, expect } from "vitest";
import {
  continuousTakeWardrobeWarning,
  foldWardrobeChanges,
  wardrobeChangeClause,
  wardrobeTimeline,
} from "@/lib/agents/wardrobe";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";

/**
 * Wardrobe as a timeline rather than a constant.
 *
 * The constant exists for a good reason — a garment left unstated is reinvented
 * on every render — but it made a costume change impossible to express rather
 * than merely discouraged. The effective outfit for a scene is the last change
 * at or before it.
 */

const TRACEY: Character = {
  id: "char-tracey",
  name: "Tracey",
  description: "A woman in her thirties.",
  wardrobe: "a plain grey sweatshirt",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SCENES = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    title: "Test",
    concept: "A test.",
    style: "cinematic",
    tone: "quiet",
    creativeMode: "short_film",
    generationMode: "video_segments",
    modelStrategy: "auto",
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    requestedDurationSeconds: 32,
    segmentSeconds: 8,
    segmentCount: 4,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    characterWardrobe: { "char-tracey": "short black silk robe" },
    ...overrides,
  } as Project;
}

describe("resolving what a character wears in each scene", () => {
  it("carries the project wardrobe through when nothing changes", () => {
    const timeline = wardrobeTimeline(project(), SCENES, [TRACEY]);
    for (const scene of SCENES) {
      expect(timeline.get(scene.id)!.start["char-tracey"]).toBe("short black silk robe");
      expect(timeline.get(scene.id)!.end["char-tracey"]).toBe("short black silk robe");
    }
  });

  it("prefers the project wardrobe over the character's library default", () => {
    const timeline = wardrobeTimeline(project(), SCENES, [TRACEY]);
    expect(timeline.get("s1")!.start["char-tracey"]).not.toBe("a plain grey sweatshirt");
  });

  /** The whole point: a change at scene 3 has to reach scene 4. */
  it("carries a change forward to every later scene", () => {
    const timeline = wardrobeTimeline(
      project({
        wardrobeChanges: {
          s3: [{ characterId: "char-tracey", wardrobe: "jeans and a white t-shirt", mode: "between" }],
        },
      }),
      SCENES,
      [TRACEY],
    );

    expect(timeline.get("s2")!.end["char-tracey"]).toBe("short black silk robe");
    expect(timeline.get("s3")!.start["char-tracey"]).toBe("jeans and a white t-shirt");
    expect(timeline.get("s4")!.start["char-tracey"]).toBe("jeans and a white t-shirt");
  });

  /**
   * A depicted change is the one place the two frames of a scene are meant to
   * differ, which is exactly what the start/end frame split can express.
   */
  it("splits the changing scene across its two frames when depicted", () => {
    const timeline = wardrobeTimeline(
      project({
        wardrobeChanges: {
          s2: [{ characterId: "char-tracey", wardrobe: "jeans and a white t-shirt", mode: "within" }],
        },
      }),
      SCENES,
      [TRACEY],
    );

    const changing = timeline.get("s2")!;
    expect(changing.start["char-tracey"]).toBe("short black silk robe");
    expect(changing.end["char-tracey"]).toBe("jeans and a white t-shirt");
    expect(changing.within).toHaveLength(1);
    expect(timeline.get("s3")!.start["char-tracey"]).toBe("jeans and a white t-shirt");
  });

  it("applies two changes in order", () => {
    const timeline = wardrobeTimeline(
      project({
        wardrobeChanges: {
          s2: [{ characterId: "char-tracey", wardrobe: "a red coat", mode: "between" }],
          s4: [{ characterId: "char-tracey", wardrobe: "a swimsuit", mode: "between" }],
        },
      }),
      SCENES,
      [TRACEY],
    );

    expect(timeline.get("s1")!.start["char-tracey"]).toBe("short black silk robe");
    expect(timeline.get("s3")!.start["char-tracey"]).toBe("a red coat");
    expect(timeline.get("s4")!.start["char-tracey"]).toBe("a swimsuit");
  });

  /** A change for someone who is not in the cast would otherwise silently apply. */
  it("ignores a change for a character not in the cast", () => {
    const timeline = wardrobeTimeline(
      project({
        wardrobeChanges: { s2: [{ characterId: "char-ghost", wardrobe: "armour", mode: "between" }] },
      }),
      SCENES,
      [TRACEY],
    );
    expect(timeline.get("s2")!.start).not.toHaveProperty("char-ghost");
  });
});

describe("telling the model what the change is", () => {
  it("names both outfits so the clip can show the transition", () => {
    const clause = wardrobeChangeClause(
      [{ characterId: "char-tracey", wardrobe: "jeans and a white t-shirt", mode: "within" }],
      [TRACEY],
      { "char-tracey": "short black silk robe" },
    );
    expect(clause).toContain("Tracey changes out of short black silk robe");
    expect(clause).toContain("into jeans and a white t-shirt");
  });

  it("says nothing when there is no depicted change", () => {
    expect(wardrobeChangeClause([], [TRACEY], {})).toBe("");
  });
});

describe("folding what the storyboard proposed", () => {
  const drafts = [
    { id: "s1", wardrobeChanges: [] },
    {
      id: "s2",
      wardrobeChanges: [
        { character: "Tracey", newWardrobe: "jeans and a white t-shirt", depictedOnScreen: true },
      ],
    },
  ];

  it("matches the agent's character name to a cast id", () => {
    const folded = foldWardrobeChanges(project(), drafts, [TRACEY]);
    expect(folded.wardrobeChanges?.s2).toEqual([
      { characterId: "char-tracey", wardrobe: "jeans and a white t-shirt", mode: "within" },
    ]);
  });

  /** A name the cast does not have is a hallucination, not an instruction. */
  it("drops a change for a character it cannot identify", () => {
    const unknown = [
      { id: "s2", wardrobeChanges: [{ character: "Nobody", newWardrobe: "x", depictedOnScreen: false }] },
    ];
    expect(foldWardrobeChanges(project(), unknown, [TRACEY]).wardrobeChanges).toBeUndefined();
  });

  /** A person set this; re-running the agent must not quietly overrule them. */
  it("leaves a scene alone when someone has already set it by hand", () => {
    const manual = project({
      wardrobeChanges: { s2: [{ characterId: "char-tracey", wardrobe: "a red coat", mode: "between" }] },
    });
    expect(foldWardrobeChanges(manual, drafts, [TRACEY]).wardrobeChanges?.s2?.[0]!.wardrobe).toBe(
      "a red coat",
    );
  });

  it("returns the project untouched when nothing was proposed", () => {
    const original = project();
    expect(foldWardrobeChanges(original, [{ id: "s1" }], [TRACEY])).toBe(original);
  });
});

describe("warning about a continuous take", () => {
  const change = [
    { characterId: "char-tracey", wardrobe: "jeans", mode: "between" as const },
  ];

  /** There is no cut to hide in, so an off-screen change looks like a glitch. */
  it("objects to an off-screen change in an unbroken take", () => {
    const warning = continuousTakeWardrobeWarning(
      project({ sceneContinuity: "reuse_end_frame" }),
      2,
      change,
    );
    expect(warning).toMatch(/no cut to hide in/);
  });

  it("still cautions about a depicted change, without objecting", () => {
    const warning = continuousTakeWardrobeWarning(
      project({ sceneContinuity: "reuse_end_frame" }),
      2,
      [{ characterId: "char-tracey", wardrobe: "jeans", mode: "within" }],
    );
    expect(warning).toMatch(/visible on screen/);
  });

  it("says nothing when the project cuts", () => {
    expect(continuousTakeWardrobeWarning(project({ sceneContinuity: "cut" }), 2, change)).toBeNull();
  });
});
