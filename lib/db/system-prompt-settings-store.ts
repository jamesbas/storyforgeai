import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/db/character-store";
import {
  emptySystemPromptSettings,
  systemPromptSettingsSchema,
  type SystemPromptSettings,
} from "@/lib/schemas/system-prompt-settings";

const FILENAME = "system-prompt-settings.json";
const settingsFile = () => path.join(libraryDir(), FILENAME);

const globalRef = globalThis as unknown as { __storyforgeSystemPromptLock?: Promise<unknown> };

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalRef.__storyforgeSystemPromptLock ?? Promise.resolve();
  const run = previous.then(fn, fn);
  globalRef.__storyforgeSystemPromptLock = run.catch(() => undefined);
  return run;
}

export const systemPromptSettingsStore = {
  async get(): Promise<SystemPromptSettings> {
    try {
      const raw = await fs.readFile(settingsFile(), "utf8");
      const parsed = systemPromptSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptySystemPromptSettings();
    } catch {
      return emptySystemPromptSettings();
    }
  },

  async save(settings: SystemPromptSettings): Promise<SystemPromptSettings> {
    return withLock(async () => {
      await fs.mkdir(libraryDir(), { recursive: true });
      const payload = systemPromptSettingsSchema.parse(settings);
      const file = settingsFile();
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, file);
      return payload;
    });
  },
};