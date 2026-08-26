import fs from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "@/lib/db/character-store";
import {
  emptyGenerationDefaults,
  generationDefaultsSchema,
  type GenerationDefaults,
} from "@/lib/schemas/generation-defaults";

/**
 * The app-wide generation defaults, in one small file beside the character
 * library.
 *
 * Same shape as that library for the same reasons: a single versioned JSON file
 * under the data directory, so it survives restarts, travels with a backup of
 * the data folder, and needs no database.
 */

const FILENAME = "generation-defaults.json";

const defaultsFile = () => path.join(libraryDir(), FILENAME);

/**
 * Serialises writes. Route handlers run concurrently in one process, so two
 * saves would otherwise read the same snapshot and the second clobber the first.
 */
const globalRef = globalThis as unknown as { __storyforgeDefaultsLock?: Promise<unknown> };

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalRef.__storyforgeDefaultsLock ?? Promise.resolve();
  const run = previous.then(fn, fn);
  globalRef.__storyforgeDefaultsLock = run.catch(() => undefined);
  return run;
}

export const generationDefaultsStore = {
  /**
   * Never throws. A missing file is a fresh install, and an unreadable or
   * outdated one must not stop projects being created — the cost of falling
   * back is that a project starts unpinned, which is where it started before
   * this existed.
   */
  async get(): Promise<GenerationDefaults> {
    try {
      const raw = await fs.readFile(defaultsFile(), "utf8");
      const parsed = generationDefaultsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptyGenerationDefaults();
    } catch {
      return emptyGenerationDefaults();
    }
  },

  async save(defaults: GenerationDefaults): Promise<GenerationDefaults> {
    return withLock(async () => {
      await fs.mkdir(libraryDir(), { recursive: true });
      const payload = generationDefaultsSchema.parse(defaults);
      await fs.writeFile(defaultsFile(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return payload;
    });
  },
};
