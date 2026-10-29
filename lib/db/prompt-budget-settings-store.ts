import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/db/character-store";
import {
  DEFAULT_PROMPT_BUDGET_SETTINGS,
  promptBudgetSettingsSchema,
  type PromptBudgetSettings,
} from "@/lib/schemas/prompt-budget-settings";

const settingsFile = () => path.join(libraryDir(), "prompt-budget-settings.json");
const globalRef = globalThis as typeof globalThis & {
  __storyforgePromptBudgetLock?: Promise<unknown>;
};

export const promptBudgetSettingsStore = {
  async get(): Promise<PromptBudgetSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(settingsFile(), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { ...DEFAULT_PROMPT_BUDGET_SETTINGS };
      }
      throw new Error("Could not read prompt length settings.", { cause: error });
    }
    try {
      return promptBudgetSettingsSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error("Saved prompt length settings are invalid.", { cause: error });
    }
  },

  async save(settings: PromptBudgetSettings): Promise<PromptBudgetSettings> {
    const payload = promptBudgetSettingsSchema.parse(settings);
    const previous = globalRef.__storyforgePromptBudgetLock ?? Promise.resolve();
    const run = previous.then(async () => {
      await fs.mkdir(libraryDir(), { recursive: true });
      const file = settingsFile();
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, file);
      return payload;
    });
    globalRef.__storyforgePromptBudgetLock = run.catch(() => undefined);
    return run;
  },
};
