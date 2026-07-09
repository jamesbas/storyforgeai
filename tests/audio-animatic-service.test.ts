import { describe, it, expect } from "vitest";
import {
  createProject,
  generateStoryboard,
  generateAudioPlan,
  generateAnimatic,
  getProjectRecord,
} from "@/lib/services/project-service";
import { ValidationError } from "@/lib/errors";

describe("audio + animatic service flow", () => {
  it("generates an audio plan aligned to the storyboard scenes", async () => {
    const project = await createProject({
      concept: "A narrator guides a night walk.",
      requestedDurationSeconds: 60,
      narrationRequired: true,
      musicRequired: true,
    });
    await generateStoryboard(project.id);
    const record = await generateAudioPlan(project.id);
    expect(record.audioPlan).toBeDefined();
    expect(record.audioPlan!.sceneAudioCues).toHaveLength(3);
    expect(record.audioPlan!.sceneAudioCues[0]!.sceneId).toBe(
      record.storyboard!.scenes[0]!.id,
    );
  });

  it("builds an animatic and exposes its plan for export", async () => {
    const project = await createProject({
      concept: "A kite tours the city.",
      requestedDurationSeconds: 90,
    });
    await generateStoryboard(project.id);
    const record = await generateAnimatic(project.id);
    expect(record.animaticPlan).toBeDefined();
    expect(record.animaticPlan!.frames).toHaveLength(project.segmentCount);
    const actions = (record.history ?? []).map((h) => h.action);
    expect(actions).toContain("animatic.generated");
  });

  it("refuses to build an animatic before a storyboard exists", async () => {
    const project = await createProject({
      concept: "An idea with no storyboard yet.",
      requestedDurationSeconds: 40,
    });
    await expect(generateAnimatic(project.id)).rejects.toBeInstanceOf(ValidationError);
    const record = await getProjectRecord(project.id);
    expect(record.animaticPlan).toBeUndefined();
  });
});
