import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  generateStoryboard,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { generateSceneMedia } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * A clip is sent the same exclusions a keyframe is.
 *
 * The video pass passed `videoNegativePrompt` straight through to the manifest,
 * so none of what the image pass had learned applied to it: a term the agent
 * scoped to one character by name steered every body in the clip, a library
 * negative written about one person applied to all of them, and a crowded shot
 * got none of the duplication guards. All of that is composed at render time,
 * from the terms already stored, so no prompt has to be rewritten for it.
 */

/** `jobs` is the mock's own map of renders, so the log needs a name of its own. */
class RecordingClient extends MockWangpClient {
  readonly calls: { prompt: string; negative: string; length: unknown }[] = [];
  async generate(settings: Record<string, unknown>) {
    this.calls.push({
      prompt: String(settings.prompt ?? ""),
      negative: String(settings.negative_prompt ?? ""),
      length: settings.video_length,
    });
    return super.generate(settings);
  }
}

let client: RecordingClient;

beforeEach(() => {
  client = new RecordingClient();
  setWangpClient(client);
});

/** The clip job, which is the only one carrying a frame count. */
const clip = () => client.calls.find((call) => call.length !== undefined);

const CROWDED =
  "Medium shot, eye level. Three people stand in the doorway. " +
  "Exactly three people are in frame: one woman and two men.";

async function project(): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "Three strangers wait out a storm in a lighthouse keeper's kitchen.",
    requestedDurationSeconds: 40,
    sceneContinuity: "cut",
  });
  return generateStoryboard(created.id);
}

async function renderWith(negative: string): Promise<string> {
  const record = await project();
  const scene = record.storyboard!.scenes[0]!;
  await updateScenePrompts(record.project.id, scene.id, {
    startFramePrompt: CROWDED,
    endFramePrompt: CROWDED,
    videoNegativePrompt: negative,
  });
  client.calls.length = 0;
  await generateSceneMedia(record.project.id, scene.id);
  return clip()!.negative;
}

describe("the exclusions a clip is sent", () => {
  it("guards a crowded clip against duplication, as the keyframe already was", async () => {
    const negative = await renderWith("blur");
    expect(negative).toContain("blur");
    expect(negative).toContain("the same face twice");
    expect(negative).toContain("extra limbs");
  });

  /**
   * The population comes from the start frame. A video prompt is told not to
   * re-describe what that frame already shows, so it states no headcount of its
   * own — and every check keyed on one would be disarmed if this read the clip
   * prompt instead.
   */
  it("reads the headcount from the frame the clip opens on", async () => {
    const record = await project();
    const scene = record.storyboard!.scenes[0]!;
    expect(scene.prompts.videoPromptSegment).not.toMatch(/exactly \w+ people/i);

    expect(await renderWith("blur")).toContain("the same face twice");
  });

  /** The point of the change: one composer, so neither pass can drift again. */
  it("treats the clip and its keyframes alike", async () => {
    await renderWith("blur");
    const frames = client.calls.filter((call) => call.length === undefined);

    expect(frames.length).toBeGreaterThan(0);
    for (const call of [...frames, clip()!]) {
      expect(call.negative).toContain("the same face twice");
    }
  });

  it("drops an exclusion the clip's own prompt asks for", async () => {
    const record = await project();
    const scene = record.storyboard!.scenes[0]!;
    const asked = scene.prompts.videoPromptSegment.split(/\s+/).find((w) => /^[a-z]{6,}$/.test(w))!;
    await updateScenePrompts(record.project.id, scene.id, {
      startFramePrompt: CROWDED,
      videoNegativePrompt: `blur, ${asked}`,
    });
    client.calls.length = 0;
    await generateSceneMedia(record.project.id, scene.id);

    expect(clip()!.negative).toContain("blur");
    expect(clip()!.negative).not.toContain(asked);
  });

  it("strips prose negation, which a sampler cannot read", async () => {
    const negative = await renderWith("no watermarks, avoid blur");
    expect(negative).toContain("watermarks");
    expect(negative).not.toContain("no watermarks");
    expect(negative).toContain("blur");
  });
});
