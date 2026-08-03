import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import {
  MAX_TASKS_PER_PROJECT,
  TASK_SCHEMA_VERSION,
  emptyTaskFile,
  isTerminal,
  needsOperator,
  taskFileSchema,
  type Task,
  type TaskFile,
} from "@/lib/schemas/tasks";

/**
 * Durable task storage (SPEC-008, ADR-008 §A/§B).
 *
 * A separate `tasks.json` beside `project.json` rather than a field on the
 * project record: §15 requires a corrupt task file to be quarantined *without
 * losing the project*, which one document cannot do, and task state changes far
 * more often than a storyboard does.
 */

const FILENAME = "tasks.json";

/** Same guard as the project repository: ids must not escape the data dir. */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function projectDir(projectId: string): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), config.dataDir, projectId);
}

function taskFilePath(projectId: string): string {
  return path.join(projectDir(projectId), FILENAME);
}

export interface TaskRepository {
  read(projectId: string): Promise<TaskFile>;
  /** Read-modify-write under the project's own lock. */
  mutate(projectId: string, apply: (file: TaskFile) => TaskFile | void): Promise<TaskFile>;
  clear(projectId: string): Promise<void>;
}

/**
 * Drop terminal tasks oldest-first once over the cap (FR-9).
 *
 * Anything active or awaiting an operator is never pruned: an interrupted task
 * is the only record that a GPU job may still be running, and losing it would
 * strand the job with nobody knowing.
 */
export function pruneTasks(tasks: readonly Task[]): Task[] {
  const keepAlways = tasks.filter((t) => !isTerminal(t.state) || needsOperator(t.state));
  const prunable = tasks
    .filter((t) => isTerminal(t.state) && !needsOperator(t.state))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const room = Math.max(0, MAX_TASKS_PER_PROJECT - keepAlways.length);
  const kept = new Set(prunable.slice(-room).map((t) => t.id));
  return tasks.filter((t) => keepAlways.includes(t) || kept.has(t.id));
}

export class FileTaskRepository implements TaskRepository {
  /**
   * One chain per project rather than the repo-wide chain `FileProjectRepository`
   * uses, so a long batch on one project cannot stall another's transitions.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  private async serialise<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.chains.set(
      projectId,
      run.catch(() => undefined),
    );
    return run;
  }

  async read(projectId: string): Promise<TaskFile> {
    return this.serialise(projectId, () => this.readUnlocked(projectId));
  }

  private async readUnlocked(projectId: string): Promise<TaskFile> {
    if (!SAFE_ID.test(projectId)) throw new Error(`Refusing to read tasks for unsafe id.`);
    const target = taskFilePath(projectId);
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch {
      return emptyTaskFile();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine(projectId, "unparseable");
      return emptyTaskFile();
    }

    const result = taskFileSchema.safeParse(parsed);
    if (!result.success) {
      await this.quarantine(projectId, "schema_mismatch");
      return emptyTaskFile();
    }
    // A file written by a newer build may hold fields this one would silently
    // drop on the next write, so it is set aside rather than downgraded.
    if (result.data.schemaVersion > TASK_SCHEMA_VERSION) {
      await this.quarantine(projectId, "newer_schema");
      return emptyTaskFile();
    }
    return result.data;
  }

  /**
   * Move a bad file aside instead of deleting it.
   *
   * The operator keeps the evidence, and the project still loads — which is the
   * whole reason tasks are not stored on the project record.
   */
  private async quarantine(projectId: string, reason: string): Promise<void> {
    const target = taskFilePath(projectId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const parked = path.join(projectDir(projectId), `tasks.corrupt-${stamp}.json`);
    await fs.rename(target, parked).catch(() => undefined);
    logEvent("task.quarantined", { projectId, reason });
  }

  async mutate(projectId: string, apply: (file: TaskFile) => TaskFile | void): Promise<TaskFile> {
    return this.serialise(projectId, async () => {
      const current = await this.readUnlocked(projectId);
      const applied = apply(current) ?? current;
      const next: TaskFile = {
        ...applied,
        schemaVersion: TASK_SCHEMA_VERSION,
        revision: current.revision + 1,
        tasks: pruneTasks(applied.tasks),
      };
      await this.writeUnlocked(projectId, next);
      return next;
    });
  }

  private async writeUnlocked(projectId: string, file: TaskFile): Promise<void> {
    if (!SAFE_ID.test(projectId)) throw new Error(`Refusing to persist tasks for unsafe id.`);
    await fs.mkdir(projectDir(projectId), { recursive: true });
    const target = taskFilePath(projectId);
    const temp = `${target}.tmp`;
    // Same tmp-then-rename as the project repository: a crash mid-write leaves
    // the previous file intact rather than a truncated one that fails to parse.
    await fs.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  }

  async clear(projectId: string): Promise<void> {
    await this.serialise(projectId, async () => {
      await fs.rm(taskFilePath(projectId), { force: true });
      this.chains.delete(projectId);
    });
  }
}

/** Ephemeral store for tests and `STORYFORGE_PERSISTENCE=memory`. */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly files = new Map<string, TaskFile>();

  async read(projectId: string): Promise<TaskFile> {
    return structuredClone(this.files.get(projectId) ?? emptyTaskFile());
  }

  async mutate(projectId: string, apply: (file: TaskFile) => TaskFile | void): Promise<TaskFile> {
    const current = this.files.get(projectId) ?? emptyTaskFile();
    const applied = apply(structuredClone(current)) ?? current;
    const next: TaskFile = {
      ...applied,
      schemaVersion: TASK_SCHEMA_VERSION,
      revision: current.revision + 1,
      tasks: pruneTasks(applied.tasks),
    };
    this.files.set(projectId, next);
    return structuredClone(next);
  }

  async clear(projectId: string): Promise<void> {
    this.files.delete(projectId);
  }
}

const globalRef = globalThis as unknown as {
  __storyforgeTaskRepo?: TaskRepository;
  __storyforgeWorkerId?: string;
};

function createRepository(): TaskRepository {
  return config.persistence === "memory" ? new InMemoryTaskRepository() : new FileTaskRepository();
}

export const taskRepository: TaskRepository =
  globalRef.__storyforgeTaskRepo ?? (globalRef.__storyforgeTaskRepo = createRepository());

/**
 * This process's lease owner id.
 *
 * On `globalThis` so an HMR reload reuses it — otherwise every hot reload would
 * look like a different worker and fight itself for the lease.
 */
export function workerId(): string {
  return (globalRef.__storyforgeWorkerId ??= randomUUID());
}

/** Test seam; the repository is a process-wide singleton otherwise. */
export function resetTaskRepository(): void {
  globalRef.__storyforgeTaskRepo = createRepository();
}
