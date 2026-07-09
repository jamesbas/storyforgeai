import { describe, it, expect } from "vitest";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { assembleRoughCut, listExports } from "@/lib/services/assembly-service";
import { assemblySchema } from "@/lib/schemas/assembly";
import { runDeepy } from "@/lib/deepy/deepy";

async function projectWithAllMedia(seconds: number) {
  const project = await createProject({
    concept: "A comet crosses the sky.",
    requestedDurationSeconds: seconds,
  });
  const withStoryboard = await generateStoryboard(project.id);
  for (const scene of withStoryboard.storyboard!.scenes) {
    const gen = await generateSceneMedia(project.id, scene.id);
    const attempt = gen.attempts![scene.id]![0]!;
    await approveAttempt(project.id, scene.id, attempt.id);
  }
  return project;
}

describe("assembly service", () => {
  it("assembles a rough cut from approved clips", async () => {
    const project = await projectWithAllMedia(40);
    const record = await assembleRoughCut(project.id);
    expect(record.assembly).toBeDefined();
    expect(() => assemblySchema.parse(record.assembly)).not.toThrow();
    expect(record.assembly!.plan.clips).toHaveLength(2);
    expect(record.assembly!.roughCutPath).toContain("rough-cut.mp4");
    expect(record.project.status).toBe("assembled");
  });

  it("exposes an export package with available flags", async () => {
    const project = await projectWithAllMedia(20);
    await assembleRoughCut(project.id);
    const exports = await listExports(project.id);
    const names = exports.map((e) => e.name);
    expect(names).toContain("storyboard.json");
    expect(names).toContain("final-cut-plan.json");
    expect(exports.find((e) => e.name === "final-cut-plan.json")!.available).toBe(true);
  });

  it("fails to assemble when no media has been generated", async () => {
    const project = await createProject({
      concept: "Nothing generated.",
      requestedDurationSeconds: 20,
    });
    await generateStoryboard(project.id);
    await expect(assembleRoughCut(project.id)).rejects.toThrow();
  });
});

describe("deepy assistant", () => {
  it("labels responses as simulated when disabled", () => {
    const result = runDeepy("inspect_video_frame", "clip.mp4");
    expect(result.action).toBe("inspect_video_frame");
    expect(result.enabled).toBe(false);
    expect(result.result).toContain("simulated");
  });
});
