import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { repository } from "@/lib/db/store";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { assembleRoughCut, listMedia } from "@/lib/services/assembly-service";
import {
  NativeFfmpegRunner,
  probeDurationSeconds,
  runProcess,
  setFfmpegRunner,
} from "@/lib/media/ffmpeg";
import { parseMediaRef, resolveMediaPath } from "@/lib/media/refs";
import { streamFile } from "@/lib/media/streaming";
import { config } from "@/lib/config";
import type { SceneAttempt } from "@/lib/schemas/generation";

const hasFfmpeg = await runProcess("ffmpeg", ["-version"], 15_000)
  .then((r) => r.code === 0)
  .catch(() => false);

/**
 * Full pipeline against real ffmpeg: storyboard -> real clip files -> assembled
 * rough cut on disk -> resolved through the opaque media reference -> streamed.
 * Skipped when ffmpeg is unavailable.
 */
describe.skipIf(!hasFfmpeg)("assembly pipeline with native ffmpeg (integration)", () => {
  const clipDir = path.resolve(config.dataDir, `__test-clips-${randomUUID()}`);
  const clips: string[] = [];

  beforeAll(async () => {
    await fs.mkdir(clipDir, { recursive: true });
    for (const [index, color] of ["red", "blue", "green"].entries()) {
      const out = path.join(clipDir, `clip-${index}.mp4`);
      const result = await runProcess(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=320x240:r=24:d=22`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          out,
        ],
        180_000,
      );
      expect(result.code).toBe(0);
      clips.push(out);
    }
    setFfmpegRunner(new NativeFfmpegRunner());
  }, 240_000);

  afterAll(async () => {
    setFfmpegRunner(undefined);
    await fs.rm(clipDir, { recursive: true, force: true });
  });

  it("writes a real rough cut, trims to the requested runtime, and streams it", async () => {
    // 50s requested -> three 20s segments (60s generated) -> 10s final trim.
    const project = await createProject({
      concept: "A kite escapes over the harbour.",
      requestedDurationSeconds: 50,
    });
    const withStoryboard = await generateStoryboard(project.id);
    const scenes = withStoryboard.storyboard!.scenes;
    expect(scenes).toHaveLength(3);

    const attempts: Record<string, SceneAttempt[]> = {};
    scenes.forEach((scene, index) => {
      attempts[scene.id] = [
        {
          id: randomUUID(),
          sceneId: scene.id,
          attemptNumber: 1,
          videoPath: clips[index]!,
          settingsIds: [],
          approved: true,
          createdAt: new Date().toISOString(),
        },
      ];
    });
    await repository.update(project.id, { ...withStoryboard, attempts });

    const record = await assembleRoughCut(project.id);
    const assembly = record.assembly!;

    try {
      // The concat already applies the last scene's 10s trim, so the rough cut
      // lands on the requested 50s runtime rather than the 60s generated.
      const roughStats = await fs.stat(assembly.roughCutPath);
      expect(roughStats.size).toBeGreaterThan(0);
      expect(assembly.plan.totalDurationSeconds).toBe(50);
      expect(assembly.plan.finalTrimSeconds).toBe(10);

      const roughSeconds = await probeDurationSeconds(assembly.roughCutPath);
      expect(roughSeconds!).toBeGreaterThan(48);
      expect(roughSeconds!).toBeLessThan(52);

      // The cut is exposed as an available, servable descriptor.
      const media = await listMedia(project.id);
      const roughDescriptor = media.find((m) => m.role === "rough_cut");
      expect(roughDescriptor?.available).toBe(true);
      expect(roughDescriptor!.url).toBe(`/api/projects/${project.id}/media/rough-cut`);
      // The descriptor must not leak a filesystem path to the browser.
      expect(JSON.stringify(roughDescriptor)).not.toContain(clipDir);
      expect(JSON.stringify(roughDescriptor)).not.toContain("assembly");

      // Scene clips resolve through the opaque reference and stream with ranges.
      const sceneDescriptor = media.find((m) => m.role === "video" && m.available);
      expect(sceneDescriptor).toBeDefined();
      const ref = parseMediaRef(sceneDescriptor!.assetId)!;
      const resolved = resolveMediaPath(record, ref);
      expect(resolved).toBe(path.resolve(clips[0]!));

      const partial = await streamFile(
        resolved!,
        new Request("http://localhost/x", { headers: { range: "bytes=0-511" } }),
      );
      expect(partial.status).toBe(206);
      expect(partial.headers.get("Content-Length")).toBe("512");
    } finally {
      await fs.rm(path.resolve(config.dataDir, project.id), { recursive: true, force: true });
    }
  }, 300_000);
});
