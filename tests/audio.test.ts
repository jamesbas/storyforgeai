import { describe, it, expect } from "vitest";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import { audioPlanSchema, animaticPlanSchema, voiceProfileSchema } from "@/lib/schemas/audio";
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
  const sceneIds = ["s1", "s2", "s3"];

  it("builds a schema-valid audio plan with one cue per scene", () => {
    const plan = buildAudioPlan(project, sceneIds);
    expect(() => audioPlanSchema.parse(plan)).not.toThrow();
    expect(plan.sceneAudioCues).toHaveLength(3);
  });

  it("includes narrator and character voice profiles when required", () => {
    const plan = buildAudioPlan(project, sceneIds);
    for (const v of plan.voiceProfiles) expect(() => voiceProfileSchema.parse(v)).not.toThrow();
    expect(plan.voiceProfiles.map((v) => v.role)).toContain("narrator");
    expect(plan.voiceProfiles.map((v) => v.role)).toContain("character");
    expect(plan.sceneAudioCues.every((c) => c.lipSyncRequired)).toBe(true);
  });

  it("omits voices and cues when nothing is required", () => {
    const silent = makeProject({
      narrationRequired: false,
      dialogueRequired: false,
      musicRequired: false,
      sfxRequired: false,
    });
    const plan = buildAudioPlan(silent, sceneIds);
    expect(plan.voiceProfiles).toHaveLength(0);
    expect(plan.sceneAudioCues.every((c) => !c.lipSyncRequired)).toBe(true);
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
