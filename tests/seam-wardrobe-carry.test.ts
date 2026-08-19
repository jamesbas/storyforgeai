import { describe, it, expect, beforeEach } from "vitest";
import { createProject, generateStoryboard, getProjectRecord } from "@/lib/services/project-service";
import { generateSceneMedia } from "@/lib/services/media-service";
import { castSystemDirective } from "@/lib/agents/cast";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";

/**
 * What a carried-over start frame is allowed to dictate.
 *
 * Under `reuse_end_frame` a scene's start frame is the previous scene's end
 * frame, and the end frame is rendered against it so wardrobe and hair hold
 * across the seam. The instruction that does that used to read "The character's
 * wardrobe … identical clothing" — singular and unscoped — so when the cast
 * changed across the seam the model dressed the *new* person in the clothing it
 * could see, and an unnamed man arrived wearing a named character's outfit.
 */
class RecordingClient extends MockWangpClient {
  prompts: string[] = [];

  async generate(settings: Record<string, unknown>) {
    if (typeof settings.prompt === "string") this.prompts.push(settings.prompt);
    return super.generate(settings);
  }
}

let client: RecordingClient;

beforeEach(() => {
  client = new RecordingClient();
  setWangpClient(client);
});

async function twoScenesCarryingTheSeam() {
  const created = await createProject({
    concept: "A woman waits in a hotel room, then a stranger arrives at the door.",
    requestedDurationSeconds: 40,
    generationMode: "keyframes_only",
    sceneContinuity: "reuse_end_frame",
  });
  const withStoryboard = await generateStoryboard(created.id);
  for (const scene of withStoryboard.storyboard!.scenes) {
    await generateSceneMedia(created.id, scene.id);
  }
  return getProjectRecord(created.id);
}

describe("the instruction that carries wardrobe across a seam", () => {
  it("scopes the carry-over to the named cast", async () => {
    const record = await twoScenesCarryingTheSeam();
    const inherited = Object.values(record.attempts ?? {})
      .flat()
      .some((attempt) => attempt.startImageInherited);
    expect(inherited).toBe(true);

    const carried = client.prompts.filter((prompt) =>
      prompt.includes("exactly as in the supplied reference"),
    );
    expect(carried.length).toBeGreaterThan(0);
    for (const prompt of carried) {
      expect(prompt).toContain("named characters'");
    }
  });

  /**
   * The clause that stops a new person being dressed from the reference. Its
   * absence is what put a named character's outfit on a stranger.
   */
  it("tells anyone outside that frame to dress from this scene's own description", async () => {
    await twoScenesCarryingTheSeam();

    const carried = client.prompts.filter((prompt) =>
      prompt.includes("exactly as in the supplied reference"),
    );
    expect(carried.length).toBeGreaterThan(0);
    expect(
      carried.every((prompt) =>
        prompt.includes("never takes clothing from a person in the reference frame"),
      ),
    ).toBe(true);
  });

  it("never issues the old unscoped wording", async () => {
    await twoScenesCarryingTheSeam();
    for (const prompt of client.prompts) {
      expect(prompt).not.toContain("The character's wardrobe");
    }
  });

  /**
   * Preserve-only wording preserved the composition too. Asked for a medium
   * shot of two characters walking away from a doorway toward a bed, the end
   * frame returned the doorway — the reference's geography, not the scene's.
   * Every model that can be handed a reference frame is an edit checkpoint, and
   * an edit checkpoint answers the question it is asked, so the instruction now
   * asks for the change and says where the geography comes from.
   */
  it("says the shot's geography comes from the scene, not the reference", async () => {
    await twoScenesCarryingTheSeam();

    const carried = client.prompts.filter((prompt) =>
      prompt.includes("exactly as in the supplied reference"),
    );
    expect(carried.length).toBeGreaterThan(0);
    for (const prompt of carried) {
      expect(prompt).toContain("Edit the supplied reference frame into this shot");
      expect(prompt).toContain(
        "come from this scene's own description, not from the reference frame",
      );
      expect(prompt).toContain("Integrate every change naturally");
    }
  });
});

describe("what the prompt agents are told about people outside the cast", () => {
  /**
   * An unnamed person with no garments in the prompt is dressed by whatever the
   * reference frame shows, which is the other half of the same failure.
   */
  it("warns that an undescribed person inherits someone else's outfit", () => {
    const directive = castSystemDirective([], true);
    expect(directive).toContain("specific named garments with colours");
    expect(directive).toContain("another character's outfit");
  });
});
