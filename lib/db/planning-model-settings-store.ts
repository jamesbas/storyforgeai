import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/db/character-store";
import {
  EMPTY_STAGE_MODELS,
  legacyPlanningModelSettingsSchema,
  planningModelSettingsSchema,
  type PlanningModelSettings,
} from "@/lib/schemas/planning-model-settings";

const settingsFile = () => path.join(libraryDir(), "planning-model-settings.json");
const globalRef = globalThis as typeof globalThis & {
  __storyforgePlanningModelLock?: Promise<unknown>;
};

function parseSettings(raw: unknown): PlanningModelSettings {
  const current = planningModelSettingsSchema.safeParse(raw);
  if (current.success) return current.data;
  // A file written before stages existed keeps meaning what it meant.
  const legacy = legacyPlanningModelSettingsSchema.parse(raw);
  return { version: 2, model: legacy.model, stages: { ...EMPTY_STAGE_MODELS } };
}

export const planningModelSettingsStore = {
  async get(): Promise<PlanningModelSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(settingsFile(), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 2, model: null, stages: { ...EMPTY_STAGE_MODELS } };
      }
      throw new Error("Could not read planning model settings.", { cause: error });
    }
    try {
      return parseSettings(JSON.parse(raw));
    } catch (error) {
      throw new Error("Saved planning model settings are invalid.", { cause: error });
    }
  },

  /**
   * Replace the saved settings with what `change` makes of the current ones.
   *
   * Read and write happen inside the same lock, so two saves that each touch
   * one stage cannot erase one another's.
   */
  async update(
    change: (current: PlanningModelSettings) => PlanningModelSettings,
  ): Promise<PlanningModelSettings> {
    const previous = globalRef.__storyforgePlanningModelLock ?? Promise.resolve();
    const run = previous.then(async () => {
      const payload = planningModelSettingsSchema.parse(change(await planningModelSettingsStore.get()));
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
