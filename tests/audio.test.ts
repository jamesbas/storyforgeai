import { describe, it, expect } from "vitest";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import { audioPlanSchema, animaticPlanSchema, voiceProfileSchema, audioCueSchema } from "@/lib/schemas/audio";
import { buildAudioPlan, buildAnimaticPlan } from "@/lib/agents/mock-audio";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

function makeProject(overrides: Partial<Project> = {}): Project {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  return {
    id: "audio-project",
    title: "Audio Project",
    concept: "A radio host narrates a city at night.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "moody",
    creativeMode: "film_short",
    narrationRequired: true,
    dialogueRequired: true,
    musicRequired: true,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("audio plan", () => {
  const project = makeProject();
  const scenes = [
    { id: "s1", sceneNumber: 1, durationSeconds: 20 },
    { id: "s2", sceneNumber: 2, durationSeconds: 20 },
    { id: "s3", sceneNumber: 3, durationSeconds: 20 },
  ];

  it("builds a schema-valid audio plan with one cue per scene", () => {
    const plan = buildAudioPlan(project, scenes);
    expect(() => audioPlanSchema.parse(plan)).not.toThrow();
    expect(plan.sceneAudioCues).toHaveLength(3);
  });

  it("includes narrator and character voice profiles when required", () => {
    const plan = buildAudioPlan(project, scenes);
    for (const v of plan.voiceProfiles) expect(() => voiceProfileSchema.parse(v)).not.toThrow();
    expect(plan.voiceProfiles.map((v) => v.role)).toContain("narrator");
    expect(plan.voiceProfiles.map((v) => v.role)).toContain("character");
  });

  it("proposes a timed, ducked music cue per scene when music is required", () => {
    const plan = buildAudioPlan(project, scenes);
    expect(plan.cues).toHaveLength(3);
    for (const cue of plan.cues) {
      expect(cue.kind).toBe("music");
      expect(() => audioCueSchema.parse(cue)).not.toThrow();
      // Music sits under the clip's own audio so rendered dialogue survives.
      expect(cue.duckNativeDb).toBeLessThan(0);
      // The cue must fit inside its 20s anchor scene.
      expect(cue.startSeconds + cue.durationSeconds).toBeLessThanOrEqual(20);
      expect(cue.approved).toBe(false);
      expect(cue.generatedPath).toBeUndefined();
    }
  });

  it("adds an additive SFX cue when SFX are required", () => {
    const plan = buildAudioPlan(makeProject({ sfxRequired: true }), scenes);
    const sfx = plan.cues.filter((c) => c.kind === "sfx");
    expect(sfx).toHaveLength(3);
    // An SFX hit mixes on top rather than pushing the clip audio down.
    for (const cue of sfx) expect(cue.duckNativeDb).toBe(0);
  });

  it("omits voices and cues when nothing is required", () => {
    const silent = makeProject({
      narrationRequired: false,
      dialogueRequired: false,
      musicRequired: false,
      sfxRequired: false,
    });
    const plan = buildAudioPlan(silent, scenes);
    expect(plan.voiceProfiles).toHaveLength(0);
    expect(plan.cues).toHaveLength(0);
  });

  it("keeps cues inside very short scenes", () => {
    const plan = buildAudioPlan(project, [{ id: "s1", sceneNumber: 1, durationSeconds: 2 }]);
    for (const cue of plan.cues) {
      expect(cue.startSeconds).toBeGreaterThanOrEqual(0);
      expect(cue.durationSeconds).toBeGreaterThan(0);
      expect(cue.startSeconds + cue.durationSeconds).toBeLessThanOrEqual(2);
    }
  });
});

describe("animatic plan", () => {
  it("builds a schema-valid animatic from a storyboard", async () => {
    const project = makeProject();
    const storyboard = await runStoryboardOrchestrator(project, { provider: null });
    const record: ProjectRecord = { project, storyboard };
    const plan = buildAnimaticPlan(record);
    expect(() => animaticPlanSchema.parse(plan)).not.toThrow();
    expect(plan.frames).toHaveLength(project.segmentCount);
    expect(plan.totalDurationSeconds).toBe(
      plan.frames.reduce((s, f) => s + f.durationSeconds, 0),
    );
  });

  it("throws when no storyboard exists", () => {
    const project = makeProject();
    expect(() => buildAnimaticPlan({ project })).toThrow();
  });
});
