import { describe, it, expect } from "vitest";
import { createProject, generateStoryboard, generateWorldBible, generateVariants, getProjectRecord } from "@/lib/services/project-service";
import { projectRecordSchema } from "@/lib/schemas/storyboard";
import { latestExecution } from "@/lib/schemas/provenance";
import { importProject } from "@/lib/services/project-service";

/**
 * Provenance is written in the same `repository.update` call as the artifact it
 * describes, so a record can never claim an artifact the file does not hold.
 */
describe("provenance is committed with its artifact", () => {
  it("stores a record for every storyboard artifact in one write", async () => {
    const project = await createProject({
      concept: "A cartographer runs out of paper.",
      requestedDurationSeconds: 40,
    });
    const record = await generateStoryboard(project.id);

    expect(record.storyboard).toBeDefined();
    expect(record.executions?.length).toBeGreaterThan(0);

    // Read back from the repository, not the returned object.
    const reloaded = await getProjectRecord(project.id);
    expect(reloaded.executions).toEqual(record.executions);
    expect(latestExecution(reloaded.executions, "brief")).toBeDefined();
    expect(latestExecution(reloaded.executions, "story_plan")).toBeDefined();
    expect(latestExecution(reloaded.executions, "visual_bible")).toBeDefined();
    expect(latestExecution(reloaded.executions, "storyboard")).toBeDefined();
  });

  it("records one image and one video execution per scene", async () => {
    const project = await createProject({
      concept: "A lamplighter forgets one street.",
      requestedDurationSeconds: 40,
    });
    const record = await generateStoryboard(project.id);
    const scenes = record.storyboard!.scenes;

    for (const scene of scenes) {
      const image = latestExecution(record.executions, `${scene.id}.image_prompt`);
      const video = latestExecution(record.executions, `${scene.id}.video_prompt`);
      expect(image?.scope).toBe(scene.id);
      expect(video?.scope).toBe(scene.id);
      // Independently recorded, as the spec requires.
      expect(image!.executionId).not.toBe(video!.executionId);
    }
  });

  it("ties one user action together with a correlation id", async () => {
    const project = await createProject({
      concept: "A ferryman counts the same passenger twice.",
      requestedDurationSeconds: 20,
    });
    const record = await generateStoryboard(project.id);
    const ids = new Set(record.executions!.map((e) => e.correlationId));

    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it("keeps canvas provenance alongside the plan it describes", async () => {
    const project = await createProject({
      concept: "A beekeeper inherits a locked greenhouse.",
      requestedDurationSeconds: 20,
    });
    const record = await generateWorldBible(project.id);

    expect(record.worldBible).toBeDefined();
    expect(latestExecution(record.executions, "world_bible")).toMatchObject({
      source: "deterministic",
      status: "ok",
    });
  });

  it("keeps a later run's record without losing the earlier artifact's", async () => {
    const project = await createProject({
      concept: "A archivist mislabels a decade.",
      requestedDurationSeconds: 20,
    });
    await generateVariants(project.id);
    const record = await generateWorldBible(project.id);

    expect(latestExecution(record.executions, "variants")).toBeDefined();
    expect(latestExecution(record.executions, "world_bible")).toBeDefined();
  });
});

describe("projects written before provenance existed", () => {
  it("parses with no executions rather than looking like model output", () => {
    const legacy = {
      project: {
        id: "legacy-1",
        title: "Legacy",
        concept: "x",
        requestedDurationSeconds: 20,
        segmentSeconds: 20,
        segmentCount: 1,
        generatedDurationSeconds: 20,
        finalTrimSeconds: 0,
        aspectRatio: "16:9",
        resolutionPreset: "standard",
        style: "cinematic",
        tone: "calm",
        creativeMode: "film_short",
        narrationRequired: false,
        dialogueRequired: false,
        musicRequired: false,
        sfxRequired: false,
        generationMode: "storyboard_only",
        modelStrategy: "auto",
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const parsed = projectRecordSchema.parse(legacy);
    expect(parsed.executions).toBeUndefined();
    // Absent, not empty: nothing can be mistaken for a recorded LLM run.
    expect(latestExecution(parsed.executions, "storyboard")).toBeUndefined();
  });

  it("imports a project that carries provenance, and one that does not", async () => {
    const project = await createProject({
      concept: "A tram driver keeps a diary of delays.",
      requestedDurationSeconds: 20,
    });
    const withProvenance = await generateStoryboard(project.id);

    const imported = await importProject(JSON.parse(JSON.stringify(withProvenance)));
    const importedRecord = await getProjectRecord(imported.project.id);
    expect(importedRecord.executions?.length).toBe(withProvenance.executions!.length);

    const stripped = JSON.parse(JSON.stringify(withProvenance)) as Record<string, unknown>;
    delete stripped.executions;
    const legacyImport = await importProject(stripped);
    const legacyRecord = await getProjectRecord(legacyImport.project.id);
    expect(legacyRecord.executions).toBeUndefined();
  });
});
