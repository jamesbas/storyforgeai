import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  approveAttempt,
  clearSceneSeed,
  generateSceneKeyframe,
  generateSceneMedia,
} from "@/lib/services/media-service";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { encodeMediaRef, parseMediaRef, resolveMediaPath } from "@/lib/media/refs";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { config } from "@/lib/config";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Keyframe previews.
 *
 * A preview exists so a prompt or model change can be judged from one still
 * rather than a whole scene. The property that matters is isolation: media
 * listing and assembly both take a scene's newest attempt, so a preview that
 * leaked into `attempts` would mask a finished clip.
 */

async function seeded() {
  const project = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 40,
  });
  return generateStoryboard(project.id);
}

function sceneOf(record: ProjectRecord) {
  return record.storyboard!.scenes[0]!;
}

describe("pinned scene seeds", () => {
  it("reuses one seed across previews so a preview predicts the keyframe", async () => {
    const project = await seeded();
    const scene = sceneOf(project);

    const first = await generateSceneKeyframe(project.project.id, scene.id, "start_frame");
    const pinned = first.project.sceneSeeds?.[scene.id];
    expect(pinned).toBeTypeOf("number");

    const second = await generateSceneKeyframe(project.project.id, scene.id, "end_frame");
    expect(second.project.sceneSeeds?.[scene.id]).toBe(pinned);
  });

  it("mints a different seed after a re-roll", async () => {
    const project = await seeded();
    const scene = sceneOf(project);

    const first = await generateSceneKeyframe(project.project.id, scene.id, "start_frame");
    const pinned = first.project.sceneSeeds?.[scene.id];

    const cleared = await clearSceneSeed(project.project.id, scene.id);
    expect(cleared.project.sceneSeeds?.[scene.id]).toBeUndefined();

    const next = await generateSceneKeyframe(project.project.id, scene.id, "start_frame");
    expect(next.project.sceneSeeds?.[scene.id]).toBeTypeOf("number");
    expect(next.project.sceneSeeds?.[scene.id]).not.toBe(pinned);
  });

  /**
   * The regression this guards: both keyframes sampled the scene's one pinned
   * seed, and since they share a prompt skeleton — and the end frame is rendered
   * with the start frame as a reference — the pair came back as the same picture.
   */
  it("samples the two keyframes at different seeds", async () => {
    class SeedRecordingClient extends MockWangpClient {
      readonly seeds: unknown[] = [];
      async generate(settings: Record<string, unknown>) {
        this.seeds.push(settings.seed);
        return super.generate(settings);
      }
    }
    const client = new SeedRecordingClient();
    setWangpClient(client);

    const project = await seeded();
    const scene = sceneOf(project);
    await generateSceneKeyframe(project.project.id, scene.id, "start_frame");
    await generateSceneKeyframe(project.project.id, scene.id, "end_frame");

    expect(client.seeds).toHaveLength(2);
    expect(client.seeds[0]).toBeTypeOf("number");
    expect(client.seeds[1]).not.toBe(client.seeds[0]);

    setWangpClient(new MockWangpClient());
  });
});

describe("rendering a single keyframe", () => {
  it("stores a start frame as a preview", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);

    const record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");

    expect(record.previews?.[scene.id]?.startFramePath).toBeTruthy();
    expect(record.previews?.[scene.id]?.endFramePath).toBeUndefined();
  });

  it("stores an end frame independently of the start frame", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);

    let record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");
    record = await generateSceneKeyframe(seed.project.id, scene.id, "end_frame");

    expect(record.previews?.[scene.id]?.startFramePath).toBeTruthy();
    expect(record.previews?.[scene.id]?.endFramePath).toBeTruthy();
  });

  /** The whole point: a preview must not look like a generation attempt. */
  it("creates no attempt and leaves scene status alone", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    const statusBefore = scene.status;

    const record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");

    expect(record.attempts?.[scene.id] ?? []).toHaveLength(0);
    expect(record.storyboard!.scenes[0]!.status).toBe(statusBefore);
  });

  /**
   * The regression this guards: media listing shows a scene's newest attempt, so
   * a preview stored as one would replace a finished clip in the UI.
   */
  it("does not displace the media of an already generated scene", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);

    const generated = await generateSceneMedia(seed.project.id, scene.id);
    const attempt = generated.attempts![scene.id]![0]!;
    expect(attempt.videoPath).toBeTruthy();

    const record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");

    // The attempt, its clip, and its approval state all survive untouched.
    expect(record.attempts?.[scene.id]).toHaveLength(1);
    expect(record.attempts![scene.id]![0]!.videoPath).toBe(attempt.videoPath);
    expect(record.attempts![scene.id]![0]!.id).toBe(attempt.id);
  });

  it("does not disturb an approved attempt", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    const generated = await generateSceneMedia(seed.project.id, scene.id);
    const approved = await approveAttempt(
      seed.project.id,
      scene.id,
      generated.attempts![scene.id]![0]!.id,
    );
    expect(approved.attempts![scene.id]![0]!.approved).toBe(true);

    const record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");

    expect(record.attempts![scene.id]![0]!.approved).toBe(true);
  });

  it("records the preview in project history", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    const record = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");
    expect(record.history?.some((h) => h.action === "scene.keyframe_preview")).toBe(true);
  });

  it("refuses an unknown scene", async () => {
    const seed = await seeded();
    await expect(
      generateSceneKeyframe(seed.project.id, "no-such-scene", "start_frame"),
    ).rejects.toThrow();
  });
});

describe("preview media references", () => {
  it("round-trips through encode and parse", () => {
    const ref = { kind: "preview", sceneId: "abc-scene-001", role: "end_frame" } as const;
    const assetId = encodeMediaRef(ref);
    expect(assetId).toBe("preview~abc-scene-001~end_frame");
    expect(parseMediaRef(assetId)).toEqual(ref);
  });

  it("rejects an unsafe scene id or unknown role", () => {
    expect(parseMediaRef("preview~../escape~start_frame")).toBeNull();
    expect(parseMediaRef("preview~abc~video")).toBeNull();
    expect(parseMediaRef("preview~abc")).toBeNull();
  });

  /**
   * Served media must sit inside an approved root, so this uses a path under the
   * data directory. Mock generation paths deliberately do not resolve — see
   * media-serving.test.ts, which asserts the same thing.
   */
  it("resolves a preview stored inside the data directory", () => {
    const insideRoot = path.resolve(config.dataDir, "proj-1", "preview-start.png");
    const record = {
      project: { id: "proj-1" },
      previews: { "scene-1": { startFramePath: insideRoot, updatedAt: "now" } },
    } as unknown as ProjectRecord;

    expect(
      resolveMediaPath(record, { kind: "preview", sceneId: "scene-1", role: "start_frame" }),
    ).toBe(insideRoot);

    // The other role is absent rather than wrongly sharing the start frame.
    expect(
      resolveMediaPath(record, { kind: "preview", sceneId: "scene-1", role: "end_frame" }),
    ).toBeNull();
  });

  it("returns nothing for a scene that has no preview", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    expect(
      resolveMediaPath(seed, { kind: "preview", sceneId: scene.id, role: "start_frame" }),
    ).toBeNull();
  });
});
