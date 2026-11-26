import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { libraryDir } from "@/lib/db/character-store";
import { logEvent } from "@/lib/telemetry";
import { emptySchedule, runScheduleSchema, type RunSchedule } from "@/lib/schemas/schedule";

/**
 * The run schedule, in one small file beside the character library.
 *
 * App-level state rather than project state, so it lives under `library/` and
 * travels with a backup of the data folder but never with a project export.
 *
 * Writes are serialised and atomic (tmp then rename), so a crash mid-write
 * leaves the previous schedule rather than half of a new one. A file that will
 * not parse is quarantined and replaced by an empty schedule (ADR-008 §B): the
 * app must still boot, and the evidence is kept for whoever wants it.
 */

export interface ScheduleStore {
  read(): Promise<RunSchedule>;
  /**
   * Read, change and write under one lock. `fn` edits the draft in place and
   * may throw to abandon the change. The revision is bumped on every write.
   */
  mutate<T>(fn: (draft: RunSchedule) => T | Promise<T>): Promise<{ schedule: RunSchedule; result: T }>;
}

function lockChain() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

const clone = (schedule: RunSchedule): RunSchedule => structuredClone(schedule);

export function createMemoryScheduleStore(initial: RunSchedule = emptySchedule()): ScheduleStore {
  let current = clone(initial);
  const withLock = lockChain();
  return {
    async read() {
      return clone(current);
    },
    mutate(fn) {
      return withLock(async () => {
        const draft = clone(current);
        const result = await fn(draft);
        draft.revision = current.revision + 1;
        current = runScheduleSchema.parse(draft);
        return { schedule: clone(current), result };
      });
    },
  };
}

export function createFileScheduleStore(file: string): ScheduleStore {
  const withLock = lockChain();

  async function load(): Promise<RunSchedule> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return emptySchedule();
    }
    try {
      return runScheduleSchema.parse(JSON.parse(raw));
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const quarantined = path.join(path.dirname(file), `run-schedule.corrupt-${stamp}.json`);
      await fs.rename(file, quarantined).catch(() => undefined);
      logEvent("scheduler.quarantined", {
        file: path.basename(quarantined),
        error: err instanceof Error ? err.message.slice(0, 200) : "unparseable",
      });
      return emptySchedule();
    }
  }

  async function save(schedule: RunSchedule): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(schedule, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }

  return {
    read: () => withLock(load),
    mutate(fn) {
      return withLock(async () => {
        const before = await load();
        const draft = clone(before);
        const result = await fn(draft);
        draft.revision = before.revision + 1;
        const next = runScheduleSchema.parse(draft);
        await save(next);
        return { schedule: clone(next), result };
      });
    },
  };
}

export const scheduleFile = () => path.join(libraryDir(), "run-schedule.json");

const globalRef = globalThis as unknown as { __storyforgeScheduleStore?: ScheduleStore };

/** Process-wide store. Memory persistence (tests) never touches the data dir. */
export function scheduleStore(): ScheduleStore {
  globalRef.__storyforgeScheduleStore ??=
    config.persistence === "memory"
      ? createMemoryScheduleStore()
      : createFileScheduleStore(scheduleFile());
  return globalRef.__storyforgeScheduleStore;
}

/** Test seam. */
export function setScheduleStore(store: ScheduleStore): void {
  globalRef.__storyforgeScheduleStore = store;
}
