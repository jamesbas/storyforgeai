import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
} from "@/lib/services/project-service";
import {
  approveAllScenes,
  approveAttempt,
  generateSceneMedia,
} from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";

/**
 * Approving eighteen scenes one card at a time is the case this answers.
 *
 * What it must not do is make a project *look* ready: a scene that never
 * rendered has nothing to approve, and assembly re-reads the same rule
 * immediately afterwards, so a count claimed here that the cut cannot honour
 * would be contradicted on the next screen.
 */

async function seeded(seconds = 60) {
  const project = await createProject({
    concept: "A robot paints the sunset from a cliff.",
    requestedDurationSeconds: seconds,
  });
  return generateStoryboard(project.id);
}

beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

describe("approving every scene at once", () => {
  it("approves a take for each rendered scene", async () => {
    const record = await seeded();
    const id = record.project.id;
    for (const scene of record.storyboard!.scenes) {
      await generateSceneMedia(id, scene.id);
    }

    const { result, record: after } = await approveAllScenes(id);

    expect(result.approved).toBe(record.storyboard!.scenes.length);
    expect(result.skipped).toEqual([]);
    for (const scene of record.storyboard!.scenes) {
      expect(after.attempts![scene.id]!.filter((a) => a.approved)).toHaveLength(1);
    }
  });

  it("takes the newest take when a scene has been re-rendered", async () => {
    const record = await seeded(40);
    const id = record.project.id;
    const scene = record.storyboard!.scenes[0]!;
    await generateSceneMedia(id, scene.id);
    await generateSceneMedia(id, scene.id);

    const { record: after } = await approveAllScenes(id);
    const attempts = after.attempts![scene.id]!;

    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.approved)?.id).toBe(attempts[1]!.id);
  });

  it("leaves a scene with no media alone and says why", async () => {
    const record = await seeded(40);
    const id = record.project.id;
    const [first, second] = record.storyboard!.scenes;
    await generateSceneMedia(id, first!.id);

    const { result } = await approveAllScenes(id);

    expect(result.approved).toBe(1);
    expect(result.skipped.map((s) => s.sceneId)).toEqual([second!.id]);
    expect(result.skipped[0]?.reason).toBe("no_attempt");
  });

  it("does not disturb a scene already approved on an older take", async () => {
    // Choosing an earlier take is a decision, not a gap to be filled.
    const record = await seeded(40);
    const id = record.project.id;
    const scene = record.storyboard!.scenes[0]!;
    await generateSceneMedia(id, scene.id);
    const older = (await getProjectRecord(id)).attempts![scene.id]![0]!;
    await approveAttempt(id, scene.id, older.id);
    await generateSceneMedia(id, scene.id);
    await approveAttempt(id, scene.id, older.id);

    const { record: after } = await approveAllScenes(id);

    expect(after.attempts![scene.id]!.find((a) => a.approved)?.id).toBe(older.id);
  });

  it("reports nothing approved when nothing has been rendered", async () => {
    const record = await seeded(40);

    const { result } = await approveAllScenes(record.project.id);

    expect(result.approved).toBe(0);
    expect(result.skipped).toHaveLength(record.storyboard!.scenes.length);
  });

  it("leaves the project assemblable once it has approved everything", async () => {
    const record = await seeded(40);
    const id = record.project.id;
    for (const scene of record.storyboard!.scenes) {
      await generateSceneMedia(id, scene.id);
    }

    await approveAllScenes(id);
    const { assemblyReadiness } = await import("@/lib/media/assembly");

    expect(assemblyReadiness(await getProjectRecord(id)).ready).toBe(true);
  });
});
