// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { countWords, wordBudget } from "@/lib/agents/media-prompt-spec";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { createProject } from "@/lib/services/project-service";
import {
  DEFAULT_PROMPT_BUDGET_SETTINGS,
  type PromptBudgetSettings,
} from "@/lib/schemas/prompt-budget-settings";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

const custom = (patch: Partial<PromptBudgetSettings>): PromptBudgetSettings => ({
  ...DEFAULT_PROMPT_BUDGET_SETTINGS,
  ...patch,
});

describe("word budgets", () => {
  it("keeps the model defaults for one person", () => {
    expect(wordBudget("krea", "image", 0)).toBe(120);
    expect(wordBudget("flux", "image", 0)).toBe(120);
    expect(wordBudget("qwen", "image", 0)).toBe(140);
    expect(wordBudget("wan", "video", 20)).toBe(85);
    expect(wordBudget("ltx", "video", 20)).toBe(150);
    expect(wordBudget("minimax_ref2va", "video", 20)).toBe(140);
  });

  it("grows the image budget with each extra person, up to the maximum", () => {
    const at = (people: number) => wordBudget("krea", "image", 0, { people });
    expect([1, 2, 3, 4, 5, 6].map(at)).toEqual([120, 140, 160, 180, 200, 200]);
    expect(wordBudget("qwen", "image", 0, { people: 4 })).toBe(200);
  });

  it("treats no people and one person alike", () => {
    expect(wordBudget("krea", "image", 0, { people: 0 })).toBe(120);
  });

  it("applies saved limits", () => {
    const settings = custom({ imageWords: 150, wordsPerExtraPerson: 10, imageMaxWords: 170 });
    const at = (people: number) => wordBudget("krea", "image", 0, { settings, people });
    expect([1, 2, 3, 4].map(at)).toEqual([150, 160, 170, 170]);
  });

  it("never lets the maximum undercut the one-person limit", () => {
    const settings = custom({ imageWords: 300, imageMaxWords: 200 });
    expect(wordBudget("krea", "image", 0, { settings, people: 3 })).toBe(300);
  });

  it("uses one video limit for every model and clip length when set", () => {
    const settings = custom({ videoWords: 200 });
    expect(wordBudget("wan", "video", 5, { settings })).toBe(200);
    expect(wordBudget("ltx", "video", 20, { settings })).toBe(200);
  });

  it("does not let video settings move the image ceiling", () => {
    expect(wordBudget("krea", "image", 0, { settings: custom({ videoWords: 500 }) })).toBe(120);
  });
});

describe("saved prompt length settings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-prompt-budget-"));
    vi.stubEnv("STORYFORGE_DATA_DIR", dir);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts at the defaults", async () => {
    const { getPromptBudgetSettings } = await import("@/lib/services/prompt-budget-settings-service");
    expect(await getPromptBudgetSettings()).toEqual(DEFAULT_PROMPT_BUDGET_SETTINGS);
  });

  it("persists a change across a restart", async () => {
    const first = await import("@/lib/services/prompt-budget-settings-service");
    await first.savePromptBudgetSettings({
      imageWords: 140, wordsPerExtraPerson: 25, imageMaxWords: 260, videoWords: null,
    });
    vi.resetModules();
    const second = await import("@/lib/services/prompt-budget-settings-service");
    expect(await second.getPromptBudgetSettings()).toEqual({
      version: 1, imageWords: 140, wordsPerExtraPerson: 25, imageMaxWords: 260, videoWords: null,
    });
  });

  it("rejects values outside the supported range and unknown fields", async () => {
    const { savePromptBudgetSettings } = await import("@/lib/services/prompt-budget-settings-service");
    const valid = { imageWords: null, wordsPerExtraPerson: 20, imageMaxWords: 200, videoWords: null };
    await expect(savePromptBudgetSettings({ ...valid, imageWords: 5 })).rejects.toThrow();
    await expect(savePromptBudgetSettings({ ...valid, videoWords: 9000 })).rejects.toThrow();
    await expect(savePromptBudgetSettings({ ...valid, wordsPerExtraPerson: 1.5 })).rejects.toThrow();
    await expect(savePromptBudgetSettings({ ...valid, extra: 1 })).rejects.toThrow();
  });

  it("falls back to the built-in limits rather than failing a run when the file is damaged", async () => {
    await fs.mkdir(path.join(dir, "library"), { recursive: true }).catch(() => undefined);
    const { promptBudgetSettingsStore } = await import("@/lib/db/prompt-budget-settings-store");
    const { resolvePromptBudgetSettings, getPromptBudgetSettings } = await import(
      "@/lib/services/prompt-budget-settings-service"
    );
    await promptBudgetSettingsStore.save(custom({ imageWords: 200 }));
    const file = (await fs.readdir(dir, { recursive: true }))
      .find((name) => name.endsWith("prompt-budget-settings.json"))!;
    await fs.writeFile(path.join(dir, file), "{ not json", "utf8");

    await expect(getPromptBudgetSettings()).rejects.toThrow("invalid");
    expect(await resolvePromptBudgetSettings()).toEqual(DEFAULT_PROMPT_BUDGET_SETTINGS);
  });

  it("serves and saves through the API route", async () => {
    const route = await import("@/app/api/settings/prompt-budgets/route");
    const put = await route.PUT(new Request("http://x/api/settings/prompt-budgets", {
      method: "PUT",
      body: JSON.stringify({
        imageWords: 130, wordsPerExtraPerson: 20, imageMaxWords: 200, videoWords: 120,
      }),
    }));
    expect(put.status).toBe(200);
    const got = await (await route.GET()).json();
    expect(got.settings).toMatchObject({ imageWords: 130, videoWords: 120 });
  });
});

describe("prompt writing with saved limits", () => {
  const body = (words: number) =>
    Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  const group =
    "Medium wide shot, eye level. Exactly three people are in frame: one man, one woman and one girl. ";

  /** Carries the card's own action so the acceptance gate has nothing to object to. */
  const framePromptFor = (action: string, total: number) => {
    const lead = `${group}${action.trim().replace(/\.?$/, ".")} `;
    return `${lead}${body(total - countWords(lead) - 1)} end.`;
  };

  async function run(budgets: PromptBudgetSettings, total: number) {
    const project = {
      ...await createProject({
        concept: "Three friends share a quiet dinner at a long table.",
        requestedDurationSeconds: 40,
      }),
      imageModel: "krea2_turbo",
      videoModel: "wan2_2_i2v_A14B",
      sceneContinuity: "cut" as const,
      style: "",
      tone: "",
    };
    const [draft] = buildSceneDrafts(
      project, buildStoryPlan(project), buildCreativeBrief(project), buildVisualBible(project),
    );
    const framePrompt = framePromptFor(draft!.actionDescription, total);
    const systems: string[] = [];
    const provider: PlanningProvider = {
      name: "budget-test",
      async generateJson(system, _user, schema) {
        if (system.includes("Image Prompt Agent")) {
          systems.push(system);
          return schema.parse({
            startFramePrompt: framePrompt,
            endFramePrompt: framePrompt,
            imageNegativePrompt: "blur",
          });
        }
        return schema.parse({
          videoPromptSegment: "They talk.",
          videoNegativePrompt: "flicker",
          promptQualityChecklist: [],
        });
      },
    };
    const [scene] = await attachScenePrompts(
      project,
      [{ ...draft!, charactersPresent: [] }],
      provider,
      { budgets },
    );
    return { scene: scene!, systems };
  }

  it("lets a three-person frame use the extra room instead of being cut to 120", async () => {
    const { scene, systems } = await run(DEFAULT_PROMPT_BUDGET_SETTINGS, 150);
    expect(systems).toHaveLength(1);
    expect(countWords(scene.prompts.startFramePrompt)).toBe(150);
    expect(scene.prompts.startFramePrompt).toMatch(/end\.$/);
  });

  it("cuts the same prompt down when the saved limits do not grow with people", async () => {
    const { scene, systems } = await run(custom({ wordsPerExtraPerson: 0 }), 150);
    expect(systems).toHaveLength(2);
    expect(systems[1]).toMatch(/at most (\d+) words/);
    expect(countWords(scene.prompts.startFramePrompt)).toBeLessThanOrEqual(120);
  });

  it("states the saved limit in the instruction the model receives", async () => {
    const { systems } = await run(custom({ imageWords: 90, wordsPerExtraPerson: 0 }), 150);
    expect(systems[0]).toContain("within 90 words");
  });
});
