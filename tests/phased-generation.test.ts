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
  qcEnabled?: boolean;
}): Promise<ProjectRecord> {
  const character = await characterWithPhoto(options.faceSwap);
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: (options.scenes ?? 3) * 20,
    useCharacterLibrary: true,
    characterIds: [character.id],
    ...(options.qcEnabled ? { qcEnabled: true } : {}),
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
    const seeded = await project({ faceSwap: true, qcEnabled: true });
    const phases: string[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["keyframes", "face_swap", "video", "qc"]);
  });

  /** QC is opt-in, so its phase must not appear — or be counted — by default. */
  it("has no QC phase when the project has not asked for it", async () => {
    const seeded = await project({ faceSwap: true });
    const phases: string[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["keyframes", "face_swap", "video"]);
  });

  /**
   * A phase can run for an hour without a scene chip changing, which reads as a
   * stalled job. Progress within the phase is the only signal that it is not.
   */
  it("reports a total and a running count for every phase", async () => {
    const seeded = await project({ faceSwap: true });
    const sceneCount = sceneIdsOf(seeded).length;
    const totals: Record<string, number> = {};
    const counts: Record<string, number[]> = {};
    let current = "";

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: (phase, total) => {
        current = phase;
        totals[phase] = total;
        counts[phase] = [];
      },
      onPhaseProgress: (completed) => counts[current]!.push(completed),
    });

    expect(totals.keyframes).toBe(sceneCount);
    expect(totals.video).toBe(sceneCount);
    // One start frame plus an end frame per scene, all distinct.
    expect(totals.face_swap).toBe(sceneCount + 1);

    // Counts climb one at a time and finish on the total.
    for (const [phase, seen] of Object.entries(counts)) {
      expect(seen).toEqual(Array.from({ length: totals[phase]! }, (_, i) => i + 1));
    }
  });

  /**
   * A preview is something the user asks for. Writing the batch's intermediate
   * keyframes into the preview map filled every scene card with stills nobody
   * requested, and left them there long after the clips landed.
   */
  it("leaves no keyframe previews behind", async () => {
    const seeded = await project({ faceSwap: true });

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded));

    const record = await getProjectRecord(seeded.project.id);
    expect(Object.keys(record.previews ?? {})).toEqual([]);
  });

  /**
   * QC is an LLM round-trip, and answering it pulls the planning model back onto
   * the GPU the batch deliberately cleared. Scoring between clips is what
   * starved the next video render of VRAM mid-run.
   */
  it("scores nothing until every clip is rendered", async () => {
    const seeded = await project({ faceSwap: true, qcEnabled: true });
    let scoredAtQc = 0;

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: async (phase) => {
        if (phase !== "qc") return;
        const record = await getProjectRecord(seeded.project.id);
        scoredAtQc = Object.values(record.attempts ?? {})
          .flat()
          .filter((attempt) => attempt.qcResult).length;
      },
    });

    expect(scoredAtQc).toBe(0);
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

  /**
   * The regression this guards: a clip that failed on scene 3 abandoned scenes 4
   * onward, throwing away keyframes already rendered and models already loaded.
   */
  it("carries on after a clip fails", async () => {
    const seeded = await project({ faceSwap: true });
    const sceneIds = sceneIdsOf(seeded);
    const completed: string[] = [];
    const failed: string[] = [];

    let renderingClips = false;
    let clip = 0;

    await generateProjectMediaPhased(seeded.project.id, sceneIds, {
      onPhase: (phase) => {
        renderingClips = phase === "video";
      },
      runStep: async (step) => {
        if (renderingClips) {
          clip += 1;
          if (clip === 1) throw new Error("CUDA out of memory");
        }
        return step();
      },
      onSceneComplete: (sceneId) => completed.push(sceneId),
      onSceneFailed: (sceneId) => failed.push(sceneId),
    });

    expect(failed).toEqual([sceneIds[0]]);
    expect(completed).toEqual(sceneIds.slice(1));
  });

  /**
   * Phase 1 had no such isolation, so a dropped connection eleven keyframes into
   * a fifteen-scene run failed every scene at once.
   */
  it("carries on after a keyframe fails", async () => {
    const seeded = await project({ faceSwap: true });
    const sceneIds = sceneIdsOf(seeded);
    const completed: string[] = [];
    const failed: string[] = [];

    let keyframes = false;
    let job = 0;

    await generateProjectMediaPhased(seeded.project.id, sceneIds, {
      onPhase: (phase) => {
        keyframes = phase === "keyframes";
      },
      runStep: async (step) => {
        if (keyframes) {
          job += 1;
          if (job === 1) throw new Error("fetch failed");
        }
        return step();
      },
      onSceneComplete: (sceneId) => completed.push(sceneId),
      onSceneFailed: (sceneId) => failed.push(sceneId),
    });

    expect(failed).toContain(sceneIds[0]);
    expect(completed).toEqual(sceneIds.slice(1));
  });

  /**
   * Phase 1 is hours of GPU time. Held only in memory, a failure anywhere later
   * threw every rendered keyframe away.
   */
  it("banks keyframes as attempts before any clip is rendered", async () => {
    const seeded = await project({ faceSwap: true });
    let bankedAtVideo: (string | undefined)[] = [];

    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded), {
      onPhase: async (phase) => {
        if (phase !== "video") return;
        const record = await getProjectRecord(seeded.project.id);
        bankedAtVideo = Object.values(record.attempts ?? {})
          .flat()
          .map((attempt) => attempt.startImagePath);
      },
    });

    expect(bankedAtVideo).toHaveLength(sceneIdsOf(seeded).length);
    expect(bankedAtVideo.every(Boolean)).toBe(true);
  });

  /** The clip completes the banked attempt rather than opening a second one. */
  it("leaves one attempt per scene once the clips land", async () => {
    const seeded = await project({ faceSwap: true });
    await generateProjectMediaPhased(seeded.project.id, sceneIdsOf(seeded));

    const record = await getProjectRecord(seeded.project.id);
    for (const sceneId of sceneIdsOf(seeded)) {
      expect(record.attempts?.[sceneId]).toHaveLength(1);
      expect(record.attempts?.[sceneId]?.[0]?.videoPath).toBeTruthy();
    }
  });
});
