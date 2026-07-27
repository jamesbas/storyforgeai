import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  updateProjectModels,
} from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { SceneContinuityMode } from "@/lib/types";

/**
 * Scene continuity modes.
 *
 * Verified against a live WanGP before implementation: `video_source` is a real
 * settings key (setting it makes WanGP ffprobe the path), and `image_prompt_type`
 * is a letter set where "V" means continue-from-source-video. Models ship that
 * field pre-set — LTX-2 defaults to "SE" — so continuing must override it, not
 * append to it.
 */

async function projectWithStoryboard(mode: SceneContinuityMode): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "A courier crosses a flooded city.",
    requestedDurationSeconds: 60,
    videoModel: "ltx2_22B",
    sceneContinuity: mode,
  });
  return generateStoryboard(project.id);
}

/** Generate scene 1 and approve it, so scene 2 has something to inherit. */
async function generateAndApprove(record: ProjectRecord, index: number): Promise<ProjectRecord> {
  const scene = record.storyboard!.scenes[index]!;
  const generated = await generateSceneMedia(record.project.id, scene.id);
  const attempt = generated.attempts![scene.id]!.at(-1)!;
  return approveAttempt(record.project.id, scene.id, attempt.id);
}

describe("scene continuity", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("defaults to a cut: every scene renders its own start and end frames", async () => {
    let record = await projectWithStoryboard("cut");
    expect(record.project.sceneContinuity).toBe("cut");

    record = await generateAndApprove(record, 0);
    record = await generateAndApprove(record, 1);

    const second = record.attempts![record.storyboard!.scenes[1]!.id]!.at(-1)!;
    const first = record.attempts![record.storyboard!.scenes[0]!.id]!.at(-1)!;

    expect(second.startImagePath).toBeDefined();
    expect(second.startImagePath).not.toBe(first.endImagePath);
    // start frame + end frame + video
    expect(second.settingsIds).toHaveLength(3);
  });

  it("reuse_end_frame starts scene 2 from scene 1's end frame and skips a render", async () => {
    let record = await projectWithStoryboard("reuse_end_frame");
    record = await generateAndApprove(record, 0);
    record = await generateAndApprove(record, 1);

    const first = record.attempts![record.storyboard!.scenes[0]!.id]!.at(-1)!;
    const second = record.attempts![record.storyboard!.scenes[1]!.id]!.at(-1)!;

    expect(second.startImagePath).toBe(first.endImagePath);
    expect(second.endImagePath).toBeDefined();
    // end frame + video only — the start frame render is skipped.
    expect(second.settingsIds).toHaveLength(2);
  });

  it("continue_video carries the previous clip and skips both keyframes", async () => {
    let record = await projectWithStoryboard("continue_video");
    record = await generateAndApprove(record, 0);
    record = await generateAndApprove(record, 1);

    const first = record.attempts![record.storyboard!.scenes[0]!.id]!.at(-1)!;
    const second = record.attempts![record.storyboard!.scenes[1]!.id]!.at(-1)!;

    expect(first.videoPath).toBeDefined();
    expect(second.startImagePath).toBeUndefined();
    expect(second.endImagePath).toBeUndefined();
    expect(second.videoPath).toBeDefined();
    // video only.
    expect(second.settingsIds).toHaveLength(1);
  });

  it("scene 1 always renders its own frames, whatever the mode", async () => {
    for (const mode of ["reuse_end_frame", "continue_video"] as const) {
      let record = await projectWithStoryboard(mode);
      record = await generateAndApprove(record, 0);
      const first = record.attempts![record.storyboard!.scenes[0]!.id]!.at(-1)!;
      expect(first.startImagePath).toBeDefined();
      expect(first.endImagePath).toBeDefined();
    }
  });

  it("falls back to a cut when the previous scene has not been generated", async () => {
    // Generating out of order must still work rather than failing or producing
    // a clip with no visual anchor at all.
    const record = await projectWithStoryboard("reuse_end_frame");
    const second = record.storyboard!.scenes[1]!;
    const generated = await generateSceneMedia(record.project.id, second.id);
    const attempt = generated.attempts![second.id]!.at(-1)!;

    expect(attempt.startImagePath).toBeDefined();
    expect(attempt.endImagePath).toBeDefined();
    expect(attempt.settingsIds).toHaveLength(3);
  });

  it("stays editable after creation", async () => {
    const record = await projectWithStoryboard("cut");
    const updated = await updateProjectModels(record.project.id, {
      sceneContinuity: "continue_video",
    });
    expect(updated.project.sceneContinuity).toBe("continue_video");
  });
});

describe("continuation settings manifest", () => {
  it("sets video_source and overrides image_prompt_type to V", async () => {
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("ltx2_22B");
    // The model ships "SE"; leaving it would make WanGP demand keyframes that
    // this mode never renders.
    expect(schema.defaultSettings.image_prompt_type).toBe("SE");

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-2",
      purpose: "video_segment",
      prompt: "the scene continues",
      videoSource: "C:\\out\\scene-1.mp4",
      fps: 24,
    });

    expect(manifest.settings.video_source).toBe("C:\\out\\scene-1.mp4");
    expect(manifest.settings.image_prompt_type).toBe("V");
  });

  it("leaves the keyframe pathway alone when not continuing", async () => {
    const client = new MockWangpClient();
    const schema = await client.getModelSchema("ltx2_22B");

    const manifest = buildSettingsManifest(schema, {
      sceneId: "scene-1",
      purpose: "video_segment",
      prompt: "a courier wades through floodwater",
      imageStart: "C:\\out\\start.png",
      imageEnd: "C:\\out\\end.png",
      fps: 24,
    });

    expect(manifest.settings.video_source).toBeUndefined();
    expect(manifest.settings.image_prompt_type).toBe("SE");
  });
});
