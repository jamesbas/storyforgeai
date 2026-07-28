import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { projectRecordSchema, type ProjectRecord } from "@/lib/schemas/storyboard";
import type { ProjectRepository } from "@/lib/db/repository";
import { logEvent } from "@/lib/telemetry";

/**
 * Durable project store on the local filesystem.
 *
 * The in-memory repository loses every storyboard when the process restarts,
 * which is a poor trade for work that takes minutes of GPU time to produce.
 * Export/import would put the burden on the user to remember; writing through
 * on every change costs nothing and cannot be forgotten.
 *
 * One JSON document per project, beside that project's generated media:
 *
 *   projects/<id>/project.json
 *
 * Records are small (a storyboard with prompts is tens of kilobytes), so the
 * whole document is rewritten on each change rather than patched.
 */

const FILENAME = "project.json";

function projectDir(id: string): string {
  return path.resolve(process.cwd(), config.dataDir, id);
}

function projectFile(id: string): string {
  return path.join(projectDir(id), FILENAME);
}

/**
 * Ids are app-generated UUIDs; refuse anything that could escape the data dir.
 *
 * The leading negative lookahead rejects `.` and `..`, which the character class
 * would otherwise admit — dots are legitimate inside an id, but an id made only
 * of them resolves to a parent directory.
 */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

export class FileProjectRepository implements ProjectRepository {
  /** Write-through cache. The disk is the source of truth; this avoids re-reading. */
  private readonly cache = new Map<string, ProjectRecord>();
  private loaded = false;
  /** Serialises writes so two concurrent saves cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  private async write(record: ProjectRecord): Promise<void> {
    const id = record.project.id;
    if (!SAFE_ID.test(id)) throw new Error(`Refusing to persist unsafe project id: ${id}`);

    const run = this.chain.then(async () => {
      await fs.mkdir(projectDir(id), { recursive: true });
      // Write to a sibling then rename: a crash mid-write leaves the previous
      // record intact rather than a truncated file that fails to parse.
      const target = projectFile(id);
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await fs.rename(temp, target);
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  private async readOne(id: string): Promise<ProjectRecord | null> {
    try {
      const raw = await fs.readFile(projectFile(id), "utf8");
      const parsed = projectRecordSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      // A record written by an older schema should not take the app down; it is
      // skipped and reported instead.
      logEvent("project.load_failed", { id, reason: "schema_mismatch" });
      return null;
    } catch {
      return null;
    }
  }

  /** Index the data directory once per process. */
  private async hydrate(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let entries: string[] = [];
    try {
      const dir = path.resolve(process.cwd(), config.dataDir);
      entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return; // No data directory yet: a fresh install has no projects.
    }

    let recovered = 0;
    for (const id of entries) {
      const record = await this.readOne(id);
      if (record) {
        this.cache.set(record.project.id, record);
        recovered += 1;
      }
    }
    if (recovered) logEvent("project.restored", { count: recovered });
  }

  async create(record: ProjectRecord): Promise<ProjectRecord> {
    await this.hydrate();
    this.cache.set(record.project.id, record);
    await this.write(record);
    return record;
  }

  async get(id: string): Promise<ProjectRecord | null> {
    await this.hydrate();
    return this.cache.get(id) ?? null;
  }

  async list(): Promise<ProjectRecord[]> {
    await this.hydrate();
    return [...this.cache.values()].sort((a, b) =>
      b.project.createdAt.localeCompare(a.project.createdAt),
    );
  }

  async update(id: string, record: ProjectRecord): Promise<ProjectRecord> {
    await this.hydrate();
    this.cache.set(id, record);
    await this.write(record);
    return record;
  }

  async delete(id: string): Promise<boolean> {
    await this.hydrate();
    const existed = this.cache.delete(id);
    // Only the record is removed. Generated media in the same folder is left
    // alone: it is expensive to reproduce and may be referenced elsewhere.
    await fs.rm(projectFile(id), { force: true }).catch(() => undefined);
    return existed;
  }

  /**
   * Remove the record and the whole project folder, generated media included.
   *
   * The id is checked against `SAFE_ID` before it reaches a recursive delete:
   * it arrives from a URL, and this is the one operation where a crafted value
   * could otherwise remove something outside the data directory.
   */
  async purge(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) throw new Error(`Refusing to purge unsafe project id: ${id}`);
    await this.hydrate();
    const existed = this.cache.delete(id);

    const target = projectDir(id);
    const root = path.resolve(process.cwd(), config.dataDir);
    // Belt and braces: the id passed SAFE_ID, so this cannot fail — but a
    // recursive delete is worth proving rather than assuming.
    if (path.dirname(target) !== root) {
      throw new Error(`Refusing to purge outside the data directory: ${target}`);
    }

    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    return existed;
  }
}
