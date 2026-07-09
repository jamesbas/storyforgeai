import { describe, it, expect } from "vitest";
import { computeSegmentation } from "@/lib/duration";
import { runStoryboardOrchestrator } from "@/lib/agents/orchestrator";
import {
  buildStoryboardExport,
  storyboardToJson,
  storyboardToMarkdown,
} from "@/lib/export/serialize";
import { storyboardExportSchema } from "@/lib/schemas/exports";
import type { Project } from "@/lib/schemas/project";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

async function makeRecord(): Promise<ProjectRecord> {
  const seg = computeSegmentation(60);
  const now = new Date().toISOString();
  const project: Project = {
    id: "export-project",
    title: "Export Project",
    concept: "A paper boat sails a rain gutter to the sea.",
    requestedDurationSeconds: 60,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "watercolor",
    tone: "gentle",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: true,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "storyboard_ready",
    createdAt: now,
    updatedAt: now,
  };
  const storyboard = await runStoryboardOrchestrator(project);
  return { project, storyboard };
}

describe("storyboard export", () => {
  it("builds a schema-valid export artifact", async () => {
    const record = await makeRecord();
    const artifact = buildStoryboardExport(record);
    expect(() => storyboardExportSchema.parse(artifact)).not.toThrow();
    expect(artifact.scenes).toHaveLength(3);
    expect(artifact.version).toBe(1);
  });

  it("serializes valid JSON", async () => {
    const record = await makeRecord();
    const json = storyboardToJson(record);
    const parsed = JSON.parse(json);
    expect(parsed.project.title).toBe("Export Project");
  });

  it("serializes markdown with a scene heading per scene", async () => {
    const record = await makeRecord();
    const md = storyboardToMarkdown(record);
    expect(md).toContain("# Export Project");
    expect(md.match(/### Scene \d+/g)).toHaveLength(3);
  });

  it("throws when the storyboard has not been generated", async () => {
    const record = await makeRecord();
    expect(() => buildStoryboardExport({ project: record.project })).toThrow();
  });
});
