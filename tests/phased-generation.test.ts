import { describe, it, expect, beforeEach } from "vitest";
import { createCharacter, setReferenceImage } from "@/lib/services/character-service";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import { canRunPhased, generateProjectMediaPhased } from "@/lib/services/media-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Phased batch generation.
 *
 * WanGP holds one model at a time and a load costs more than the job, so a
 * scene-at-a-time batch spends most of its wall clock swapping models. Grouping
 * a run by model turns roughly thirty loads into three.
 *
 * The properties worth protecting are that it only engages where it actually
 * pays, and that scenes still finish one at a time so the storyboard fills in.
 */

/**
 * jsdom's File has no `arrayBuffer()`, and the upload path needs only type,
 * size and bytes — so a minimal stand-in keeps the test about phasing.
 */
function referenceUpload(): File {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    type: "image/png",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

async function characterWithPhoto(faceSwap: boolean) {
  const character = await createCharacter({
    name: "Tracey",
    description: "A woman in her forties, tall, with dark hair.",
    faceSwap,
  });
  return setReferenceImage(character.id, referenceUpload());
}

async function project(options: {
  faceSwap: boolean;
  scenes?: number;
  continuity?: "cut" | "reuse_end_frame" | "continue_video";
}): Promise<ProjectRecord> {
  const character = await characterWithPhoto(options.faceSwap);
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: (options.scenes ?? 3) * 20,
    useCharacterLibrary: true,
    characterIds: [character.id],
    ...(options.continuity ? { sceneContinuity: options.continuity } : {}),
  });
  return generateStoryboard(created.id);
}

const sceneIdsOf = (record: ProjectRecord) => record.storyboard!.scenes.map((s) => s.id);

beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

describe("when phasing engages", () => {
  it("engages for a multi-scene batch with face swap on", async () => {
    const record = await project({ faceSwap: true });
    expect(await canRunPhased(record, sceneIdsOf(record))).toBe(true);
  });

  /** Without a swap a scene needs two models, so phasing buys little. */
  it("stays out of the way when face swap is off", async () => {
    const record = await project({ faceSwap: false });
    expect(await canRunPhased(record, sceneIdsOf(record))).toBe(false);
  });

  it("stays out of the way for a single scene", async () => {
    const record = await project({ faceSwap: true, scenes: 1 });
    expect(await canRunPhased(record, sceneIdsOf(record).slice(0, 1))).toBe(false);
  });

  /**
   * `continue_video` chains each clip off the previous *rendered clip*, so video
   * generation cannot be deferred to a final phase without breaking the chain.
   */
  it("refuses when scenes continue from the previous clip", async () => {
    const record = await project({ faceSwap: true, continuity: "continue_video" });
    expect(await canRunPhased(record, sceneIdsOf(record))).toBe(false);
  });
});

describe("running a phased batch", () => {
  it("produces an attempt with media for every scene", async () => {
    const seeded = await project({ faceSwap: true });
    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded));

    const record = await getProjectRecord(seeded.project.id);
    for (const scene of record.storyboard!.scenes) {
      const attempt = record.attempts?.[scene.id]?.[0];
      expect(attempt?.videoPath).toBeTruthy();
      expect(attempt?.endImagePath).toBeTruthy();
    }
  });

  /** Progress is the thing phasing risks losing, so completion order is pinned. */
  it("completes scenes one at a time, in scene order", async () => {
    const seeded = await project({ faceSwap: true });
    const completed: string[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onSceneComplete: (sceneId) => completed.push(sceneId),
    });

    expect(completed).toEqual(sceneIdsOf(seeded));
  });

  it("reports each phase once, in order", async () => {
    const seeded = await project({ faceSwap: true });
    const phases: string[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["keyframes", "face_swap", "video"]);
  });

  /** Keyframes are persisted as previews so the storyboard fills in early. */
  it("shows keyframes before any clip exists", async () => {
    const seeded = await project({ faceSwap: true });
    let previewsAtSwap = 0;

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: async (phase) => {
        if (phase !== "video") return;
        const record = await getProjectRecord(seeded.project.id);
        previewsAtSwap = Object.keys(record.previews ?? {}).length;
      },
    });

    expect(previewsAtSwap).toBe(sceneIdsOf(seeded).length);
  });

  it("stops at the next boundary when cancelled", async () => {
    const seeded = await project({ faceSwap: true });
    const completed: string[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      shouldCancel: () => true,
      onSceneComplete: (sceneId) => completed.push(sceneId),
    });

    expect(completed).toEqual([]);
  });

  /**
   * Model swapping is what provokes transient faults, and a phased run does more
   * of it than any other path. A blip must cost one job, not the batch.
   */
  it("routes every job through the caller's retry policy", async () => {
    const seeded = await project({ faceSwap: true });
    let calls = 0;
    const runStep = <T,>(step: () => Promise<T>): Promise<T> => {
      calls += 1;
      return step();
    };

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), { runStep });

    // One start frame, an end frame per scene, and a clip per scene.
    expect(calls).toBeGreaterThanOrEqual(sceneIdsOf(seeded).length * 2);
  });
});
