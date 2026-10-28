import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/db/character-store";
import {
  planningModelSettingsSchema,
  type PlanningModelSettings,
} from "@/lib/schemas/planning-model-settings";

const settingsFile = () => path.join(libraryDir(), "planning-model-settings.json");
const globalRef = globalThis as typeof globalThis & {
  __storyforgePlanningModelLock?: Promise<unknown>;
};

export const planningModelSettingsStore = {
  async get(): Promise<PlanningModelSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(settingsFile(), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, model: null };
      }
      throw new Error("Could not read planning model settings.", { cause: error });
    }
    try {
      return planningModelSettingsSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error("Saved planning model settings are invalid.", { cause: error });
    }
  },

  async save(settings: PlanningModelSettings): Promise<PlanningModelSettings> {
    const payload = planningModelSettingsSchema.parse(settings);
    const previous = globalRef.__storyforgePlanningModelLock ?? Promise.resolve();
    const run = previous.then(async () => {
      await fs.mkdir(libraryDir(), { recursive: true });
      const file = settingsFile();
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, file);
      return payload;
    });
    globalRef.__storyforgePlanningModelLock = run.catch(() => undefined);
    return run;
  },
};
