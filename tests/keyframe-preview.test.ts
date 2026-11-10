import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import path from "node:path";
import {
  adoptScenePreview,
  approveAttempt,
  clearSceneSeed,
  clearSceneSeeds,
  generateSceneKeyframe,
  generateSceneMedia,
} from "@/lib/services/media-service";
import { createProject, generateStoryboard, updateProjectModels, updateSceneFraming } from "@/lib/services/project-service";
import { encodeMediaRef, parseMediaRef, resolveMediaPath } from "@/lib/media/refs";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { config } from "@/lib/config";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { WangpClient } from "@/lib/wangp/client";
import { unloadPlanningModelForGeneration } from "@/lib/services/llm-runtime-service";

vi.mock("@/lib/services/llm-runtime-service", async (original) => ({
  ...await original<typeof import("@/lib/services/llm-runtime-service")>(),
  unloadPlanningModelForGeneration: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.mocked(unloadPlanningModelForGeneration).mockReset().mockResolvedValue([]);
});

afterEach(() => setWangpClient(new MockWangpClient()));

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

describe("releasing the planning model before keyframe previews", () => {
  function liveClient() {
    const backend = new MockWangpClient();
    const generate = vi.fn(async (settings: Record<string, unknown>) => {
      const submitted = await backend.generate(settings);
      await backend.getJob(submitted.id);
      return backend.getJob(submitted.id);
    });
    const client: WangpClient = {
      mode: "live",
      listModels: backend.listModels.bind(backend),
      getModelSchema: backend.getModelSchema.bind(backend),
      generate,
      getJob: backend.getJob.bind(backend),
      cancelJob: backend.cancelJob.bind(backend),
      health: backend.health.bind(backend),
    };
    setWangpClient(client);
    return generate;
  }

  it.each(["start_frame", "end_frame"] as const)("waits for unloading before submitting a %s preview", async (purpose) => {
    const record = await seeded();
    const generate = liveClient();
    let release!: () => void;
    vi.mocked(unloadPlanningModelForGeneration).mockImplementation(() =>
      new Promise<string[]>((resolve) => { release = () => resolve(["feedback-model"]); }));

    const pending = generateSceneKeyframe(record.project.id, sceneOf(record).id, purpose);
    await vi.waitFor(() => expect(unloadPlanningModelForGeneration).toHaveBeenCalledOnce());
    expect(generate).not.toHaveBeenCalled();

    release();
    const rendered = await pending;
    expect(generate).toHaveBeenCalledOnce();
    const preview = rendered.previews![sceneOf(record).id]!;
    expect(purpose === "start_frame" ? preview.startFramePath : preview.endFramePath).toBeTruthy();
  });

  it("does not submit a render on unload failure, and a later preview can retry", async () => {
    const record = await seeded();
    const sceneId = sceneOf(record).id;
    const generate = liveClient();
    vi.mocked(unloadPlanningModelForGeneration).mockRejectedValueOnce(new Error("Could not unload LM Studio."));
    await expect(generateSceneKeyframe(record.project.id, sceneId, "start_frame"))
      .rejects.toThrow("Could not unload LM Studio.");
    expect(generate).not.toHaveBeenCalled();

    const retried = await generateSceneKeyframe(record.project.id, sceneId, "start_frame");
    expect(retried.previews![sceneId]!.startFramePath).toBeTruthy();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("leaves LM Studio untouched for demo previews", async () => {
    const record = await seeded();
    setWangpClient(new MockWangpClient());
    await generateSceneKeyframe(record.project.id, sceneOf(record).id, "start_frame");
    expect(unloadPlanningModelForGeneration).not.toHaveBeenCalled();
  });
});

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

  /** Re-rolling a 30-scene project a card at a time was thirty requests. */
  it("re-rolls several scenes in one go, leaving the rest pinned", async () => {
    const project = await seeded();
    const [a, b] = project.storyboard!.scenes;
    for (const scene of [a!, b!]) {
      await generateSceneKeyframe(project.project.id, scene.id, "start_frame");
    }

    const { record, cleared } = await clearSceneSeeds(project.project.id, [a!.id]);

    expect(cleared).toEqual([a!.id]);
    expect(record.project.sceneSeeds?.[a!.id]).toBeUndefined();
    expect(record.project.sceneSeeds?.[b!.id]).toBeTypeOf("number");

    const both = await clearSceneSeeds(project.project.id, [a!.id, b!.id]);
    expect(both.cleared).toEqual([b!.id]);
    expect(both.record.project.sceneSeeds).toEqual({});
  });

  it("skips scenes with no seed and unknown ids rather than refusing", async () => {
    const project = await seeded();
    const [a, b] = project.storyboard!.scenes;
    await generateSceneKeyframe(project.project.id, a!.id, "start_frame");

    const { cleared } = await clearSceneSeeds(project.project.id, [
      a!.id,
      a!.id,
      b!.id,
      "no-such-scene",
    ]);

    expect(cleared).toEqual([a!.id]);
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

  /**
   * Scene 1 has no frame to inherit, so its end frame is an edit of its own
   * opening — typically a photograph the user supplied. Under the old "match
   * this frame" instruction an edit model handed its own start frame back, so
   * the opening is shown only together with the scene's edit prompt, which
   * names what changes.
   *
   * A preview has to make the same choice as a full render, or it stops
   * predicting the keyframe it stands in for.
   */
  describe("previewing an end frame against the scene's own start", () => {
    class RequestRecordingClient extends MockWangpClient {
      readonly calls: { prompt: string; refs: string[]; model: string }[] = [];
      async generate(settings: Record<string, unknown>) {
        this.calls.push({
          prompt: String(settings.prompt ?? ""),
          refs: Array.isArray(settings.image_refs) ? (settings.image_refs as string[]) : [],
          model: String(settings.model_type ?? settings.model ?? ""),
        });
        return super.generate(settings);
      }
    }

    async function withBankedStart(options: { optOut?: boolean; imageModel?: string } = {}) {
      const seed = await seeded();
      const scene = seed.storyboard!.scenes[0]!;
      if (options.optOut) await updateSceneFraming(seed.project.id, scene.id, { endFrameReference: false });
      if (options.imageModel) await updateProjectModels(seed.project.id, { imageModel: options.imageModel });
      const generated = await generateSceneMedia(seed.project.id, scene.id);
      const attempt = generated.attempts![scene.id]!.at(-1)!;
      expect(attempt.startImageInherited).toBeUndefined();
      const client = new RequestRecordingClient();
      setWangpClient(client);
      await generateSceneKeyframe(seed.project.id, scene.id, "end_frame");
      setWangpClient(new MockWangpClient());
      return { scene, attempt, call: client.calls.at(-1)! };
    }

    it("edits scene 1's own start frame with its edit prompt", async () => {
      const { scene, attempt, call } = await withBankedStart();
      expect(scene.prompts.endFrameEditPrompt).toMatch(/^Edit the supplied reference frame/);
      expect(call.prompt.startsWith(scene.prompts.endFrameEditPrompt!)).toBe(true);
      expect(call.refs).toEqual([attempt.startImagePath]);
    });

    it("keeps the creation prompt on a model that cannot take a source frame", async () => {
      const { call } = await withBankedStart({ imageModel: "flux_dev_image" });
      expect(call.prompt).not.toContain("supplied reference frame");
      expect(call.refs).toHaveLength(0);
    });

    it("keeps the creation prompt when the scene opts out", async () => {
      const { call } = await withBankedStart({ optOut: true });
      expect(call.prompt).not.toContain("supplied reference frame");
      expect(call.refs).toHaveLength(0);
    });
  });

  it("shows a scene the frame it inherited from the one before", async () => {
    class RequestRecordingClient extends MockWangpClient {
      readonly prompts: string[] = [];
      async generate(settings: Record<string, unknown>) {
        this.prompts.push(String(settings.prompt ?? ""));
        return super.generate(settings);
      }
    }
    const seed = await seeded();
    const scenes = seed.storyboard!.scenes;

    const first = await generateSceneMedia(seed.project.id, scenes[0]!.id);
    await approveAttempt(seed.project.id, scenes[0]!.id, first.attempts![scenes[0]!.id]!.at(-1)!.id);
    const second = await generateSceneMedia(seed.project.id, scenes[1]!.id);
    const inherited = second.attempts![scenes[1]!.id]!.at(-1)!;

    // Only meaningful if this scene actually inherited; otherwise nothing is asserted.
    expect(inherited.startImageInherited).toBe(true);

    const client = new RequestRecordingClient();
    setWangpClient(client);
    await generateSceneKeyframe(seed.project.id, scenes[1]!.id, "end_frame");

    expect(client.prompts.at(-1)!).toContain("supplied reference frame");

    setWangpClient(new MockWangpClient());
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

/**
 * Keeping a preview.
 *
 * A preview that turns out to be the wanted picture used to have to be
 * downloaded and imported back to become the scene's frame. Adoption moves the
 * pointer instead, and has to leave the record saying which of the two happened
 * — an import came from outside the seed, a kept preview did not.
 */
describe("keeping a preview as the scene's frame", () => {
  it("puts the preview on the latest attempt in place of the rendered frame", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    await generateSceneMedia(seed.project.id, scene.id);
    const previewed = await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");
    const previewPath = previewed.previews![scene.id]!.startFramePath!;
    const before = previewed.attempts![scene.id]!.at(-1)!;
    expect(before.startImagePath).not.toBe(previewPath);

    const result = await adoptScenePreview(seed.project.id, scene.id, "start_frame");
    const after = result.record.attempts![scene.id]!.at(-1)!;

    expect(after.id).toBe(before.id);
    expect(after.startImagePath).toBe(previewPath);
    expect(after.startImageFromPreview).toBe(true);
    // Not an import: the seed and prompt still describe this picture.
    expect(after.startImageImported).toBeUndefined();
    // The other frame, and the attempt count, are untouched.
    expect(after.endImagePath).toBe(before.endImagePath);
    expect(result.record.attempts![scene.id]).toHaveLength(1);
  });

  /** Otherwise the same picture is listed twice — as the frame and as a preview of it. */
  it("stops calling the adopted frame a preview", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    await generateSceneMedia(seed.project.id, scene.id);
    await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");
    await generateSceneKeyframe(seed.project.id, scene.id, "end_frame");

    const result = await adoptScenePreview(seed.project.id, scene.id, "start_frame");

    expect(result.record.previews?.[scene.id]?.startFramePath).toBeUndefined();
    // The frame that was not adopted is still there to be judged.
    expect(result.record.previews?.[scene.id]?.endFramePath).toBeTruthy();

    const both = await adoptScenePreview(seed.project.id, scene.id, "end_frame");
    expect(both.record.previews?.[scene.id]).toBeUndefined();
  });

  it("reports that the clip it already had no longer matches the frames", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    const generated = await generateSceneMedia(seed.project.id, scene.id);
    expect(generated.attempts![scene.id]!.at(-1)!.videoPath).toBeTruthy();
    await generateSceneKeyframe(seed.project.id, scene.id, "end_frame");

    const result = await adoptScenePreview(seed.project.id, scene.id, "end_frame");
    expect(result.clipStale).toBe(true);
  });

  it("refuses when nothing has been previewed yet", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    await generateSceneMedia(seed.project.id, scene.id);
    await expect(adoptScenePreview(seed.project.id, scene.id, "start_frame")).rejects.toThrow(
      /Render a preview/i,
    );
  });

  it("refuses before the scene has an attempt to put the frame on", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");
    await expect(adoptScenePreview(seed.project.id, scene.id, "start_frame")).rejects.toThrow(
      /Generate this scene's media first/i,
    );
  });

  it("records the adoption in project history", async () => {
    const seed = await seeded();
    const scene = sceneOf(seed);
    await generateSceneMedia(seed.project.id, scene.id);
    await generateSceneKeyframe(seed.project.id, scene.id, "start_frame");

    const result = await adoptScenePreview(seed.project.id, scene.id, "start_frame");
    expect(result.record.history?.some((h) => h.action === "scene.preview_adopted")).toBe(true);
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
