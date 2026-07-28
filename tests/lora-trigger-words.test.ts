import { describe, it, expect } from "vitest";
import {
  appendTriggerWords,
  missingTriggerWords,
  reconcileLoras,
} from "@/lib/services/lora-service";
import { createProject, generateStoryboard, updateScenePrompts } from "@/lib/services/project-service";
import { loraSelectionSchema } from "@/lib/schemas/lora";
import { effectiveTriggerWords, needsTriggerChoice } from "@/lib/lora/trigger-words";
import type { LoraCatalog } from "@/lib/schemas/lora";

/**
 * The rule on its own. Shared by the server at generation time and the browser
 * when previewing, so both must agree exactly — a preview that disagrees with
 * what is generated is worse than no preview.
 */
describe("the trigger-word selection rule", () => {
  it("uses a single offered word without being asked", () => {
    expect(effectiveTriggerWords(undefined, ["only"])).toEqual(["only"]);
    expect(needsTriggerChoice(undefined, ["only"])).toBe(false);
  });

  it("waits for a decision when several are offered", () => {
    expect(effectiveTriggerWords(undefined, ["a", "b"])).toEqual([]);
    expect(needsTriggerChoice(undefined, ["a", "b"])).toBe(true);
  });

  it("treats an explicit empty choice as decided", () => {
    expect(effectiveTriggerWords([], ["a", "b"])).toEqual([]);
    expect(needsTriggerChoice([], ["a", "b"])).toBe(false);
  });

  it("returns nothing when the LoRA offers nothing", () => {
    expect(effectiveTriggerWords(undefined, [])).toEqual([]);
    expect(effectiveTriggerWords(["stale"], [])).toEqual([]);
  });

  it("keeps only choices the LoRA still offers", () => {
    expect(effectiveTriggerWords(["a", "gone"], ["a", "b"])).toEqual(["a"]);
  });
});

describe("persisting a trigger choice", () => {
  it("accepts a chosen subset", () => {
    const parsed = loraSelectionSchema.parse({
      name: "multi.safetensors",
      triggerWords: ["d0gg1e"],
    });
    expect(parsed.triggerWords).toEqual(["d0gg1e"]);
  });

  /** Absent and empty mean different things, so parsing must not conflate them. */
  it("keeps absent distinct from empty", () => {
    expect(loraSelectionSchema.parse({ name: "a.safetensors" }).triggerWords).toBeUndefined();
    expect(loraSelectionSchema.parse({ name: "a.safetensors", triggerWords: [] }).triggerWords).toEqual([]);
  });
});

/**
 * LoRA trigger words, and hand-editing the prompts they land in.
 *
 * Many LoRAs are inert unless a trained word appears in the prompt, so "selected
 * it, nothing changed" is the usual first experience. Appending only the words a
 * prompt is missing is what makes that automatic without producing duplicates
 * once a user starts editing prompts themselves.
 */

const catalog: LoraCatalog = {
  supported: true,
  modelType: "ltx2_22B_distilled_1_1",
  directory: "ltx2",
  loras: [
    // A multi-concept LoRA: the trigger words select between mutually exclusive
    // behaviours, so they must never all be applied at once.
    { name: "multi.safetensors", label: "Multi", triggerWords: ["d0gg1e", "c0wg1rl", "m15510n4ry"] },
    { name: "look.safetensors", label: "Look", triggerWords: ["l00k"] },
    { name: "plain.safetensors", label: "Plain", triggerWords: [] },
  ],
};

const context = { sceneId: "scene-1", modelType: "ltx2", kind: "video" as const };

describe("choosing which trigger words apply", () => {
  it("uses a lone trigger word automatically", () => {
    const resolved = reconcileLoras([{ name: "look.safetensors", strength: 1 }], catalog, context);
    expect(resolved[0]?.triggerWords).toEqual(["l00k"]);
  });

  /**
   * The case this rule exists for. A multi-concept LoRA offers alternatives, so
   * applying all of them asks for contradictory output. Nothing is applied until
   * the user picks.
   */
  it("applies nothing for a multi-trigger LoRA until one is chosen", () => {
    const resolved = reconcileLoras([{ name: "multi.safetensors", strength: 1 }], catalog, context);
    expect(resolved[0]?.triggerWords).toEqual([]);
    expect(resolved[0]?.availableTriggerWords).toEqual(["d0gg1e", "c0wg1rl", "m15510n4ry"]);
  });

  it("applies exactly the chosen trigger word", () => {
    const resolved = reconcileLoras(
      [{ name: "multi.safetensors", strength: 1, triggerWords: ["d0gg1e"] }],
      catalog,
      context,
    );
    expect(resolved[0]?.triggerWords).toEqual(["d0gg1e"]);
  });

  it("allows deliberately choosing several", () => {
    const resolved = reconcileLoras(
      [{ name: "multi.safetensors", strength: 1, triggerWords: ["d0gg1e", "c0wg1rl"] }],
      catalog,
      context,
    );
    expect(resolved[0]?.triggerWords).toEqual(["d0gg1e", "c0wg1rl"]);
  });

  /** An explicit empty choice is not the same as never having chosen. */
  it("honours an explicit choice of none", () => {
    const resolved = reconcileLoras(
      [{ name: "look.safetensors", strength: 1, triggerWords: [] }],
      catalog,
      context,
    );
    expect(resolved[0]?.triggerWords).toEqual([]);
  });

  /** A choice must not outlive the LoRA offering it. */
  it("discards a stale choice the LoRA no longer offers", () => {
    const resolved = reconcileLoras(
      [{ name: "multi.safetensors", strength: 1, triggerWords: ["d0gg1e", "removed_word"] }],
      catalog,
      context,
    );
    expect(resolved[0]?.triggerWords).toEqual(["d0gg1e"]);
  });

  it("carries none for a LoRA that declares none", () => {
    const resolved = reconcileLoras([{ name: "plain.safetensors", strength: 1 }], catalog, context);
    expect(resolved[0]?.triggerWords).toEqual([]);
    expect(resolved[0]?.availableTriggerWords).toEqual([]);
  });

  it("still canonicalises the name while resolving trigger words", () => {
    const resolved = reconcileLoras(
      [{ name: "LOOK.safetensors", strength: 1 }],
      catalog,
      context,
    );
    expect(resolved[0]?.name).toBe("look.safetensors");
    expect(resolved[0]?.triggerWords).toEqual(["l00k"]);
  });
});

describe("appending trigger words to a prompt", () => {
  const resolved = reconcileLoras(
    [
      { name: "multi.safetensors", strength: 1, triggerWords: ["d0gg1e"] },
      { name: "look.safetensors", strength: 1 },
    ],
    catalog,
    context,
  );

  it("adds every missing word once", () => {
    const result = appendTriggerWords("a lighthouse at dusk", resolved);
    expect(result).toBe("a lighthouse at dusk, d0gg1e, l00k");
  });

  /** The unchosen alternatives must never reach the prompt. */
  it("never adds the trigger words the user did not choose", () => {
    const result = appendTriggerWords("a lighthouse at dusk", resolved);
    expect(result).not.toContain("c0wg1rl");
    expect(result).not.toContain("m15510n4ry");
  });

  /** A user who typed the trigger themselves must not get it twice. */
  it("leaves a prompt that already names the trigger alone", () => {
    expect(missingTriggerWords("a lighthouse, d0gg1e, l00k", resolved)).toEqual([]);
    expect(appendTriggerWords("a lighthouse, d0gg1e, l00k", resolved)).toBe(
      "a lighthouse, d0gg1e, l00k",
    );
  });

  it("matches case-insensitively", () => {
    expect(missingTriggerWords("A lighthouse, D0GG1E, L00K", resolved)).toEqual([]);
  });

  /** Substring matches would wrongly suppress a needed trigger word. */
  it("does not treat a substring as the trigger word", () => {
    const short: LoraCatalog = {
      ...catalog,
      loras: [{ name: "cat.safetensors", label: "Cat", triggerWords: ["cat"] }],
    };
    const one = reconcileLoras([{ name: "cat.safetensors", strength: 1 }], short, context);
    expect(missingTriggerWords("concatenate the shots", one)).toEqual(["cat"]);
  });

  it("does nothing when no LoRAs are selected", () => {
    expect(appendTriggerWords("a lighthouse", [])).toBe("a lighthouse");
  });

  it("deduplicates a word shared by two LoRAs", () => {
    const shared: LoraCatalog = {
      ...catalog,
      loras: [
        { name: "a.safetensors", label: "A", triggerWords: ["shared"] },
        { name: "b.safetensors", label: "B", triggerWords: ["shared"] },
      ],
    };
    const both = reconcileLoras(
      [
        { name: "a.safetensors", strength: 1 },
        { name: "b.safetensors", strength: 1 },
      ],
      shared,
      context,
    );
    expect(appendTriggerWords("a shot", both)).toBe("a shot, shared");
  });
});

describe("editing a scene's prompts", () => {
  async function projectWithStoryboard() {
    const project = await createProject({
      concept: "A lighthouse keeper argues with his daughter about leaving the island.",
      requestedDurationSeconds: 40,
    });
    return generateStoryboard(project.id);
  }

  it("updates only the fields supplied", async () => {
    const record = await projectWithStoryboard();
    const scene = record.storyboard!.scenes[0]!;
    const untouched = scene.prompts.videoPromptSegment;

    const updated = await updateScenePrompts(record.project.id, scene.id, {
      startFramePrompt: "a hand-written start frame, m0ti0n",
    });

    const next = updated.storyboard!.scenes[0]!;
    expect(next.prompts.startFramePrompt).toBe("a hand-written start frame, m0ti0n");
    expect(next.prompts.videoPromptSegment).toBe(untouched);
  });

  it("leaves other scenes untouched", async () => {
    const record = await projectWithStoryboard();
    const [first, second] = record.storyboard!.scenes;
    const secondBefore = second!.prompts.startFramePrompt;

    const updated = await updateScenePrompts(record.project.id, first!.id, {
      startFramePrompt: "edited",
    });

    expect(updated.storyboard!.scenes[1]!.prompts.startFramePrompt).toBe(secondBefore);
  });

  it("records the edit in project history", async () => {
    const record = await projectWithStoryboard();
    const scene = record.storyboard!.scenes[0]!;
    const updated = await updateScenePrompts(record.project.id, scene.id, {
      videoPromptSegment: "edited motion",
    });
    expect(updated.history?.some((h) => h.action === "scene.prompts_edited")).toBe(true);
  });

  it("rejects an unknown scene", async () => {
    const record = await projectWithStoryboard();
    await expect(
      updateScenePrompts(record.project.id, "no-such-scene", { startFramePrompt: "x" }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects an empty patch", async () => {
    const record = await projectWithStoryboard();
    const scene = record.storyboard!.scenes[0]!;
    await expect(updateScenePrompts(record.project.id, scene.id, {})).rejects.toThrow();
  });
});
