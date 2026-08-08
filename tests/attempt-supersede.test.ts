import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  getProjectRecord,
} from "@/lib/services/project-service";
import { approveAttempt, generateSceneMedia } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";

/**
 * Which take the pipeline uses after a scene is rendered again.
 *
 * Approval is what everything downstream reads: the next scene inherits the
 * approved attempt's end frame and assembly uses its clip. Left standing across
 * a re-render it points the whole pipeline at a take that has just been
 * replaced — a scene rendered today handing the next scene a frame from last
 * week, while the card shows the new one.
 */

async function seeded() {
  const project = await createProject({
    concept: "A robot paints the sunset from a cliff.",
    requestedDurationSeconds: 40,
  });
  return generateStoryboard(project.id);
}

beforeEach(() => {
  setWangpClient(new MockWangpClient());
});

describe("re-rendering a scene", () => {
  it("supersedes the approval that was standing", async () => {
    const record = await seeded();
    const scene = record.storyboard!.scenes[0]!;

    await generateSceneMedia(record.project.id, scene.id);
    const first = (await getProjectRecord(record.project.id)).attempts![scene.id]![0]!;
    await approveAttempt(record.project.id, scene.id, first.id);

    expect(
      (await getProjectRecord(record.project.id)).attempts![scene.id]!.find((a) => a.approved)?.id,
    ).toBe(first.id);

    await generateSceneMedia(record.project.id, scene.id);
    const after = (await getProjectRecord(record.project.id)).attempts![scene.id]!;

    expect(after).toHaveLength(2);
    expect(after.some((a) => a.approved)).toBe(false);
  });

  it("leaves another scene's approval alone", async () => {
    const record = await seeded();
    const [one, two] = record.storyboard!.scenes;

    await generateSceneMedia(record.project.id, one!.id);
    await generateSceneMedia(record.project.id, two!.id);
    const twosFirst = (await getProjectRecord(record.project.id)).attempts![two!.id]![0]!;
    await approveAttempt(record.project.id, two!.id, twosFirst.id);

    await generateSceneMedia(record.project.id, one!.id);
    const after = (await getProjectRecord(record.project.id)).attempts![two!.id]!;

    expect(after.find((a) => a.approved)?.id).toBe(twosFirst.id);
  });
});
