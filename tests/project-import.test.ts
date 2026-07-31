import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  generateWorldBible,
  getProjectRecord,
  importProject,
  listProjects,
} from "@/lib/services/project-service";
import { buildStoryboardExport } from "@/lib/export/serialize";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Restoring a project from a file the app wrote.
 *
 * Import always creates a new project, so it can never overwrite work. The two
 * accepted shapes differ in what they can restore, and the difference is
 * reported rather than left to surface later as renders that quietly lost
 * their creative direction.
 */

async function seeded(concept: string): Promise<ProjectRecord> {
  const project = await createProject({
    concept,
    requestedDurationSeconds: 60,
  });
  await generateWorldBible(project.id);
  return generateStoryboard(project.id);
}

describe("importing a full project record", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("restores the scenes and the creative plans", async () => {
    const source = await seeded("A courier crosses a flooded city.");
    const { project, source: kind, missingPlans } = await importProject(source);

    expect(kind).toBe("record");
    const restored = await getProjectRecord(project.id);
    expect(restored.storyboard?.scenes).toHaveLength(source.storyboard!.scenes.length);
    expect(restored.worldBible).toBeDefined();
    expect(missingPlans).not.toContain("World Builder");
  });

  /** Overwriting would make import capable of destroying work. */
  it("creates a new project instead of replacing the original", async () => {
    const source = await seeded("A lighthouse keeper counts ships.");
    const before = (await listProjects()).length;
    const { project } = await importProject(source);

    expect(project.id).not.toBe(source.project.id);
    expect(project.title).toMatch(/\(restored\)$/);
    expect(await getProjectRecord(source.project.id)).toBeDefined();
    expect((await listProjects()).length).toBe(before + 1);
  });

  /**
   * Scene ids embed the project id, so a new id has to be carried into every
   * map keyed by them or a stale key simply never matches again.
   */
  it("rewrites scene ids to match the new project", async () => {
    const source = await seeded("A beekeeper walks a burnt orchard.");
    const { project } = await importProject(source);
    const restored = await getProjectRecord(project.id);

    for (const scene of restored.storyboard!.scenes) {
      expect(scene.projectId).toBe(project.id);
      expect(scene.id.startsWith(project.id)).toBe(true);
    }
  });

  it("can be imported twice without the second clobbering the first", async () => {
    const source = await seeded("A diver surfaces beside a drowned church.");
    const first = await importProject(source);
    const second = await importProject(source);

    expect(second.project.id).not.toBe(first.project.id);
    expect(second.project.title).toMatch(/\(restored 2\)$/);
  });
});

describe("importing a storyboard export", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("restores the scenes and prompts", async () => {
    const source = await seeded("A signalman waves a train through fog.");
    const exported = buildStoryboardExport(source);

    const { project, source: kind } = await importProject(exported);
    expect(kind).toBe("storyboard_export");

    const restored = await getProjectRecord(project.id);
    expect(restored.storyboard?.scenes).toHaveLength(source.storyboard!.scenes.length);
    expect(restored.storyboard?.scenes[0]!.prompts.startFramePrompt).toBe(
      source.storyboard!.scenes[0]!.prompts.startFramePrompt,
    );
  });

  /** The whole point of flagging: an export carries no plans at all. */
  it("reports every creative plan it could not carry", async () => {
    const source = await seeded("A cartographer redraws a shifting coast.");
    const { missingPlans } = await importProject(buildStoryboardExport(source));

    expect(missingPlans).toEqual([
      "World Builder",
      "Director",
      "Cinematographer",
      "Art Director",
    ]);
  });
});

describe("refusing what is not a project file", () => {
  it("rejects unrelated JSON", async () => {
    await expect(importProject({ hello: "world" })).rejects.toThrow(
      /Not a StoryForgeAI project file/,
    );
  });

  it("rejects a truncated record", async () => {
    await expect(importProject({ project: { id: "x" } })).rejects.toThrow(
      /Not a StoryForgeAI project file/,
    );
  });
});
