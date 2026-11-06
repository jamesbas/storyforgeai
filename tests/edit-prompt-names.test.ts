import { describe, it, expect } from "vitest";
import { withCastNamed } from "@/lib/agents/cast";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { buildCreativeBrief, buildSceneDrafts, buildStoryPlan, buildVisualBible } from "@/lib/agents/mock-agents";
import { createProject, generateStoryboard, updateScenePrompts } from "@/lib/services/project-service";
import { generateSceneKeyframe, generateSceneMedia } from "@/lib/services/media-service";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { repository } from "@/lib/db/store";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Character } from "@/lib/schemas/character";

/**
 * An edit prompt has to name the people in the frame.
 *
 * Live: scene 1's edit came back describing "a middle-aged blonde woman" and
 * never named TLBr3f. Creation prompts get a character sheet appended, which
 * names her; edit prompts deliberately do not, and her character LoRA — keyed
 * to the name, with no trigger words configured — had nothing to fire on.
 */

const UNNAMED_EDIT =
  "Edit the supplied reference frame into a medium close-up. A middle-aged blonde woman lets the " +
  "lace bra hang loose from her arms. Keep the room and lighting unchanged.";

describe("naming the cast in an edit prompt", () => {
  it("adds a missing name right after the opening sentence", () => {
    expect(withCastNamed(UNNAMED_EDIT, ["TLBr3f"])).toBe(
      "Edit the supplied reference frame into a medium close-up. The person in this frame is TLBr3f. " +
        "A middle-aged blonde woman lets the lace bra hang loose from her arms. Keep the room and lighting unchanged.",
    );
  });

  it("leaves a prompt that already names everyone untouched", () => {
    const named = "Edit the supplied reference frame: TLBr3f lowers her arms.";
    expect(withCastNamed(named, ["TLBr3f"])).toBe(named);
  });

  it("names only the people it is missing, in a frame holding several", () => {
    const prompt = "Edit the supplied reference frame: Mara sits beside him.";
    expect(withCastNamed(prompt, ["Mara", "Noah", "Dane"])).toBe(
      "Edit the supplied reference frame: Mara sits beside him. The people in this frame include Noah and Dane.",
    );
  });

  it("matches the whole name, not a fragment of another word", () => {
    expect(withCastNamed("Edit the supplied reference frame: Anna sits.", ["Ann"]))
      .toContain("The person in this frame is Ann.");
  });

  it("leaves structured Fibo edits and empty text alone", () => {
    expect(withCastNamed('{"edit_instruction":"x"}', ["Mara"])).toBe('{"edit_instruction":"x"}');
    expect(withCastNamed("", ["Mara"])).toBe("");
  });
});

const MARA: Character = {
  id: "char-mara",
  name: "Mara",
  description: "A woman in her fifties with short grey hair.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("an edit prompt written without the name", () => {
  it("is stored with the library character named", async () => {
    const p = await createProject({
      concept: "Mara puts her cup on a wooden table.",
      requestedDurationSeconds: 40,
      sceneContinuity: "reuse_end_frame",
      generationMode: "keyframes_only",
    });
    const bible = buildVisualBible(p);
    const drafts = buildSceneDrafts(p, buildStoryPlan(p), buildCreativeBrief(p), bible).map((scene) => ({
      ...scene,
      charactersPresent: ["Mara"],
      frameVisibility: { start: ["Mara"], end: ["Mara"] },
      transitionIn: "Continuous",
    }));
    const provider: PlanningProvider = {
      name: "unnamed",
      generateJson: async (system, _user, schema) => schema.parse({
        startFramePrompt: "Medium shot, eye level. Mara sits at a wooden table, cup in hand.",
        endFramePrompt: "Medium shot, eye level. Mara sits at a wooden table, the cup set down.",
        imageNegativePrompt: "watermark",
        ...(system.includes("Also return endFrameEditPrompt")
          ? { endFrameEditPrompt: "Edit the supplied reference frame: the woman sets her cup down on the table." }
          : {}),
      }),
    };
    const scenes = await attachScenePrompts(p, drafts, provider, { cast: [MARA], visualBible: bible });
    for (const scene of scenes) {
      expect(scene.prompts.endFrameEditPrompt).toMatch(/^Edit the supplied reference frame/);
      expect(scene.prompts.endFrameEditPrompt).toContain("Mara");
    }
  });

  it("is named at render time when the saved text leaves the name out", async () => {
    const calls: string[] = [];
    setWangpClient(new (class extends MockWangpClient {
      async generate(settings: Record<string, unknown>) {
        calls.push(String(settings.prompt ?? ""));
        return super.generate(settings);
      }
    })());
    const p = await createProject({
      concept: "A keeper argues with his daughter.",
      requestedDurationSeconds: 40,
      sceneContinuity: "reuse_end_frame",
    });
    const record = await generateStoryboard(p.id);
    const scene = record.storyboard!.scenes[0]!;
    await repository.update(p.id, {
      ...record,
      storyboard: {
        ...record.storyboard!,
        scenes: record.storyboard!.scenes.map((s) =>
          s.id === scene.id ? { ...s, charactersPresent: ["TLBr3f"], frameVisibility: { start: ["TLBr3f"], end: ["TLBr3f"] } } : s),
      },
    });
    await updateScenePrompts(p.id, scene.id, { endFrameEditPrompt: UNNAMED_EDIT });
    await generateSceneMedia(p.id, scene.id);
    calls.length = 0;
    await generateSceneKeyframe(p.id, scene.id, "end_frame");

    expect(calls.at(-1)).toMatch(/^Edit the supplied reference frame into a medium close-up\. The person in this frame is TLBr3f\./);
    setWangpClient(new MockWangpClient());
  });
});
