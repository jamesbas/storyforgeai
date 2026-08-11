import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  updateSceneFraming,
} from "@/lib/services/project-service";
import { generateProjectMediaPhased } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Framing owed to the scene that inherits a frame.
 *
 * Under `reuse_end_frame` a scene's end frame is the next scene's only picture
 * of these people. A man cropped at the neck in one came back deleted from the
 * scene that inherited him, his wardrobe redistributed to whoever was left, and
 * the face swap could not correct a face that was outside the frame.
 */

/** A phrase only the carry instruction uses. */
const CARRY_MARKER = "whole head inside the frame";

class RecordingClient extends MockWangpClient {
  readonly calls: string[] = [];
  async generate(settings: Record<string, unknown>) {
    this.calls.push(String(settings.prompt ?? ""));
    return super.generate(settings);
  }
}

let client: RecordingClient;

beforeEach(() => {
  client = new RecordingClient();
  setWangpClient(client);
});

async function project(continuity: "cut" | "reuse_end_frame"): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 60,
    sceneContinuity: continuity,
  });
  return generateStoryboard(created.id);
}

const sceneIdsOf = (record: ProjectRecord) => record.storyboard!.scenes.map((s) => s.id);
const carrying = () => client.calls.filter((prompt) => prompt.includes(CARRY_MARKER));

describe("a frame the next scene inherits", () => {
  it("is asked to keep every head in shot", async () => {
    const record = await project("reuse_end_frame");
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    // Every scene's end frame but the last, which nothing inherits.
    expect(carrying()).toHaveLength(sceneIdsOf(record).length - 1);
  });

  it("is the only frame asked", async () => {
    const record = await project("reuse_end_frame");
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    const startFrames = client.calls.filter((prompt) =>
      record.storyboard!.scenes.some((s) => prompt.startsWith(s.prompts.startFramePrompt)),
    );
    expect(startFrames.length).toBeGreaterThan(0);
    expect(startFrames.some((prompt) => prompt.includes(CARRY_MARKER))).toBe(false);
  });

  it("is left alone when no scene inherits anything", async () => {
    const record = await project("cut");
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    expect(carrying()).toHaveLength(0);
  });

  /**
   * A framing note appended after the cast sheet competes with the block that
   * is most of a render prompt's length, and was ignored there. It goes with
   * the shot description, which is the opening sentence.
   */
  it("states the framing with the framing, not at the end", async () => {
    const record = await project("reuse_end_frame");
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    for (const prompt of carrying()) {
      const shot = prompt.split(". ")[0]!;
      expect(prompt.startsWith(`${shot}. Frame wide enough to hold everyone:`)).toBe(true);
      // Everything the scene originally said still follows it.
      expect(prompt.indexOf(CARRY_MARKER)).toBeLessThan(prompt.length / 2);
    }
  });

  /** A scene framed without a face on purpose is not sent looking for one. */
  it("exempts a scene deliberately framed without a face", async () => {
    const record = await project("reuse_end_frame");
    const sceneIds = sceneIdsOf(record);
    await updateSceneFraming(record.project.id, sceneIds[0]!, { subjectFaceVisible: false });

    client.calls.length = 0;
    await generateProjectMediaPhased(record.project.id, sceneIds);

    expect(carrying()).toHaveLength(sceneIds.length - 2);
  });
});
