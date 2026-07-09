import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryProjectRepository } from "@/lib/db/in-memory-repository";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
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
