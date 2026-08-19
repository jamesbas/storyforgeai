import { describe, it, expect, beforeEach } from "vitest";
import {
  createProject,
  duplicateProject,
  generateStoryboard,
  getProjectRecord,
  updateProjectModels,
  updateSceneFraming,
} from "@/lib/services/project-service";
import {
  generateProjectMediaPhased,
  generateSceneMedia,
  sendsFrameReferences,
} from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Per-scene override for the end-frame reference.
 *
 * A carried-over start frame is supplied to the end-frame render as a reference
 * image, which is what holds wardrobe and location across a seam. It holds
 * everything else too: a reference-strong model keeps a prop the scene's own
 * action is supposed to remove — a wine glass that should be set down stays in
 * the character's hand. Wording does not defeat the picture, so the only lever
 * that works is withholding it, per scene.
 */

/** The marker every conditioned end-frame prompt carries. */
const REFERENCE_MARKER = "supplied reference frame";

/** `jobs` is the mock's own map of in-flight renders, so the log needs a name of its own. */
class RecordingClient extends MockWangpClient {
  readonly calls: { prompt: string; refs: string[] }[] = [];
  async generate(settings: Record<string, unknown>) {
    this.calls.push({
      prompt: String(settings.prompt ?? ""),
      refs: Array.isArray(settings.image_refs) ? (settings.image_refs as string[]) : [],
    });
    return super.generate(settings);
  }
}

let client: RecordingClient;

beforeEach(() => {
  client = new RecordingClient();
  setWangpClient(client);
});

async function chained(): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "A keeper argues with his daughter about leaving the island.",
    requestedDurationSeconds: 60,
    sceneContinuity: "reuse_end_frame",
  });
  return generateStoryboard(created.id);
}

const sceneIdsOf = (record: ProjectRecord) => record.storyboard!.scenes.map((s) => s.id);

/** Conditioned renders, by the reference image they were handed. */
const conditioned = () => client.calls.filter((call) => call.prompt.includes(REFERENCE_MARKER));

describe("turning the end-frame reference off for one scene", () => {
  it("conditions every inheriting scene by default", async () => {
    const record = await chained();
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    // Scene 1 renders its own start frame and is never shown it; the rest inherit.
    expect(conditioned()).toHaveLength(sceneIdsOf(record).length - 1);
    expect(conditioned().every((call) => call.refs.length === 1)).toBe(true);
  });

  it("withholds the image and the instruction from the chosen scene only", async () => {
    const record = await chained();
    const sceneIds = sceneIdsOf(record);
    await updateSceneFraming(record.project.id, sceneIds[1]!, { endFrameReference: false });

    client.calls.length = 0;
    await generateProjectMediaPhased(record.project.id, sceneIds);

    expect(conditioned()).toHaveLength(sceneIds.length - 2);
    // The opted-out scene still renders — it just renders from the prompt alone.
    expect(client.calls.some((call) => call.refs.length === 0)).toBe(true);
    const after = await getProjectRecord(record.project.id);
    expect(after.attempts?.[sceneIds[1]!]?.[0]?.endImagePath).toBeTruthy();
  });

  it("applies on the scene-at-a-time path too", async () => {
    const record = await chained();
    const sceneIds = sceneIdsOf(record);
    await generateSceneMedia(record.project.id, sceneIds[0]!);
    await updateSceneFraming(record.project.id, sceneIds[1]!, { endFrameReference: false });

    client.calls.length = 0;
    await generateSceneMedia(record.project.id, sceneIds[1]!);

    expect(conditioned()).toHaveLength(0);
  });

  /**
   * The override is a user's decision, so it lives on the project rather than on
   * the agent-generated scene — a regenerated storyboard would discard it.
   */
  it("survives regenerating the storyboard", async () => {
    const record = await chained();
    const sceneId = sceneIdsOf(record)[1]!;
    await updateSceneFraming(record.project.id, sceneId, { endFrameReference: false });

    const regenerated = await generateStoryboard(record.project.id);
    expect(regenerated.project.sceneEndFrameRefs?.[sceneId]).toBe(false);
  });

  /** On is the default, so re-enabling drops the key rather than storing `true`. */
  it("stores nothing once the scene is put back to matching", async () => {
    const record = await chained();
    const sceneId = sceneIdsOf(record)[1]!;

    await updateSceneFraming(record.project.id, sceneId, { endFrameReference: false });
    const off = await getProjectRecord(record.project.id);
    expect(off.project.sceneEndFrameRefs).toEqual({ [sceneId]: false });

    await updateSceneFraming(record.project.id, sceneId, { endFrameReference: true });
    const on = await getProjectRecord(record.project.id);
    expect(on.project.sceneEndFrameRefs).toBeUndefined();
  });

  it("leaves the face-in-frame flag alone", async () => {
    const record = await chained();
    const sceneId = sceneIdsOf(record)[1]!;
    await updateSceneFraming(record.project.id, sceneId, { subjectFaceVisible: false });
    await updateSceneFraming(record.project.id, sceneId, { endFrameReference: false });

    const after = await getProjectRecord(record.project.id);
    const scene = after.storyboard!.scenes.find((s) => s.id === sceneId)!;
    expect(scene.subjectFaceVisible).toBe(false);
    expect(after.project.sceneEndFrameRefs?.[sceneId]).toBe(false);
  });

  it("rejects a patch that changes nothing", async () => {
    const record = await chained();
    await expect(
      updateSceneFraming(record.project.id, sceneIdsOf(record)[0]!, {}),
    ).rejects.toThrow();
  });

  /** Scene ids embed the project id, so a stale key would silently strand it. */
  it("is rekeyed onto the copy's scenes", async () => {
    const record = await chained();
    const sceneId = sceneIdsOf(record)[1]!;
    await updateSceneFraming(record.project.id, sceneId, { endFrameReference: false });

    const copy = await duplicateProject(record.project.id);
    const copied = await getProjectRecord(copy.id);
    const keys = Object.keys(copied.project.sceneEndFrameRefs ?? {});

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(sceneId);
    expect(keys[0]).toBe(sceneIdsOf(copied)[1]);
  });
});

/**
 * The whole-project version of the same lever.
 *
 * A carried frame is a reference image, so leaving this on confines a project
 * to models that accept one: a pin of Krea 2 Turbo rendered scene 1 and was
 * substituted for the fourteen after it, dropping the Krea LoRA on the way.
 * Turning it off keeps the pin and its LoRAs for every scene. What continues to
 * carry the join is unchanged either way — the previous scene's end frame is
 * still this scene's start frame — and identity still gets its face-swap pass.
 */
describe("withholding the carried frame for the whole project", () => {
  it("sends no reference image on any scene", async () => {
    const record = await chained();
    await updateProjectModels(record.project.id, { endFrameReferences: false });

    client.calls.length = 0;
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    expect(conditioned()).toHaveLength(0);
    expect(client.calls.every((call) => call.refs.length === 0)).toBe(true);
  });

  /** The join is what inheritance does, and inheritance is not what this controls. */
  it("still carries each scene's ending into the next scene's opening", async () => {
    const record = await chained();
    await updateProjectModels(record.project.id, { endFrameReferences: false });
    await generateProjectMediaPhased(record.project.id, sceneIdsOf(record));

    const after = await getProjectRecord(record.project.id);
    const scenes = sceneIdsOf(after);
    for (const [index, sceneId] of scenes.entries()) {
      const attempt = after.attempts?.[sceneId]?.at(-1);
      if (index === 0) {
        expect(attempt?.startImageInherited).toBeUndefined();
        continue;
      }
      expect(attempt?.startImageInherited).toBe(true);
      expect(attempt?.startImagePath).toBe(after.attempts?.[scenes[index - 1]!]?.at(-1)?.endImagePath);
    }
  });

  it("lets a model that accepts no reference images render every scene", async () => {
    const record = await chained();
    await updateProjectModels(record.project.id, { endFrameReferences: false });

    expect(sendsFrameReferences((await getProjectRecord(record.project.id)).project)).toBe(false);
  });

  it("is on unless it is turned off", async () => {
    const record = await chained();
    expect(record.project.endFrameReferences).toBeUndefined();
    expect(sendsFrameReferences(record.project)).toBe(true);
  });
});
