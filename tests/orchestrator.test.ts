import { describe, it, expect, beforeEach } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { InMemoryProjectRepository } from "@/lib/db/in-memory-repository";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { computeSegmentation } from "@/lib/duration";
import type { Project } from "@/lib/schemas/project";
import { storyboardSnapshotSchema } from "@/lib/schemas/storyboard";

function makeProject(requestedDurationSeconds: number): Project {
  const seg = computeSegmentation(requestedDurationSeconds);
  const now = new Date().toISOString();
  return {
    id: "test-project",
    title: "Test Project",
    concept: "A quiet town wakes at dawn.",
    requestedDurationSeconds,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "calm",
    audience: "general",
    creativeMode: "film_short",
    narrationRequired: true,
    dialogueRequired: false,
    musicRequired: true,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

describe("storyboard orchestrator (integration with in-memory repo)", () => {
  let repo: InMemoryProjectRepository;

  beforeEach(() => {
    repo = new InMemoryProjectRepository();
  });

  it("produces one schema-valid scene per segment", async () => {
    const project = makeProject(90); // 5 segments, 10s trim
    const snapshot = await runStoryboardOrchestrator(project);

    expect(() => storyboardSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.scenes).toHaveLength(5);
    expect(snapshot.scenes[0]!.sceneNumber).toBe(1);
    expect(snapshot.scenes.every((s) => s.targetDurationSeconds === 20)).toBe(true);
  });

  it("marks the final scene trim when duration is not a multiple of 20", async () => {
    const project = makeProject(90);
    const snapshot = await runStoryboardOrchestrator(project);
    const last = snapshot.scenes.at(-1)!;
    // finalTrimSeconds = 10 -> trimAtEndSeconds = 20 - 10 = 10
    expect(last.trimAtEndSeconds).toBe(10);
  });

  it("does not trim when duration is an exact multiple of 20", async () => {
    const project = makeProject(60);
    const snapshot = await runStoryboardOrchestrator(project);
    expect(snapshot.scenes.at(-1)!.trimAtEndSeconds).toBeUndefined();
  });

  /**
   * Timing is derived from the segmentation, but the scene schema exposes it and
   * a model under structured output fills every field it is shown. One returned
   * `trimAtEndSeconds: 2` on all three scenes of a 60-second project — that
   * field is the scene's final length, so each 20-second segment rendered as a
   * 2-second clip. Nothing failed; the videos were just wrong.
   */
  it("overrules timing invented by the planning model", async () => {
    const project = makeProject(60);
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async <T,>(
        system: string,
        _user: string,
        schema: ZodType<T, ZodTypeDef, unknown>,
      ) => {
        if (!system.startsWith("You are the Storyboard Agent")) return null;
        const scenes = Array.from({ length: 3 }, (_, i) => ({
          id: `${project.id}-scene-00${i + 1}`,
          projectId: project.id,
          sceneNumber: 99,
          startTimeSeconds: 500,
          endTimeSeconds: 505,
          targetDurationSeconds: 5,
          // The real failure: no lower bound on this field, unlike
          // targetDurationSeconds, so a model's guess passes validation.
          trimAtEndSeconds: 2,
          title: `Scene ${i + 1}`,
          sceneObjective: "o",
          storyBeat: "b",
          visualDescription: "v",
          actionDescription: "a",
          cameraMovement: "static",
          transitionIn: "cut",
          transitionOut: "cut",
          continuityNotes: [],
          status: "planned",
        }));
        const parsed = schema.safeParse({ scenes });
        return parsed.success ? parsed.data : null;
      },
    };

    const snapshot = await runStoryboardOrchestrator(project, { provider });

    expect(snapshot.scenes).toHaveLength(3);
    expect(snapshot.scenes.map((s) => s.sceneNumber)).toEqual([1, 2, 3]);
    expect(snapshot.scenes.every((s) => s.targetDurationSeconds === 20)).toBe(true);
    expect(snapshot.scenes.every((s) => s.trimAtEndSeconds === undefined)).toBe(true);
    expect(snapshot.scenes.map((s) => s.startTimeSeconds)).toEqual([0, 20, 40]);
    expect(snapshot.scenes.at(-1)!.endTimeSeconds).toBe(60);
  });

  /**
   * A builder storyboard is schema-valid and looks finished, so the only way a
   * user can tell one apart is if the app says so. Recorded on the snapshot,
   * not just logged.
   */
  it("records on the snapshot when the storyboard agent fell back", async () => {
    const project = makeProject(60);
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async <T,>() => null as T | null,
    };

    const snapshot = await runStoryboardOrchestrator(project, { provider });

    expect(snapshot.fallbacks).toEqual([
      { agent: "Storyboard Agent", reason: "no_valid_response" },
    ]);
    // The scenes are still complete — that is exactly why it needs saying.
    expect(snapshot.scenes).toHaveLength(3);
  });

  it("records nothing when the model's storyboard was accepted", async () => {
    const project = makeProject(60);
    const snapshot = await runStoryboardOrchestrator(project, { provider: null });
    // No provider means the builder ran by design, not by failure.
    expect(snapshot.fallbacks).toBeUndefined();
  });

  it("round-trips through the repository", async () => {
    const project = makeProject(40);
    const snapshot = await runStoryboardOrchestrator(project);
    await repo.create({ project, storyboard: snapshot });
    const loaded = await repo.get(project.id);
    expect(loaded?.storyboard?.scenes).toHaveLength(2);
  });

  it("is deterministic for the same project", async () => {
    const project = makeProject(60);
    const a = await runStoryboardOrchestrator(project);
    const b = await runStoryboardOrchestrator(project);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
