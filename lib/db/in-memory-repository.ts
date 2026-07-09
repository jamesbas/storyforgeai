import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ProjectRepository } from "@/lib/db/repository";

/**
 * In-memory repository used in demo/local mode and tests. Per-instance and
 * non-durable by design (generic-build-spec Section 10.1).
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly records: Map<string, ProjectRecord>;

  constructor(seed?: Map<string, ProjectRecord>) {
    this.records = seed ?? new Map();
  }

  async create(record: ProjectRecord): Promise<ProjectRecord> {
    this.records.set(record.project.id, record);
    return record;
  }

  async get(id: string): Promise<ProjectRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<ProjectRecord[]> {
    return [...this.records.values()].sort((a, b) =>
      b.project.createdAt.localeCompare(a.project.createdAt),
    );
  }

  async update(id: string, record: ProjectRecord): Promise<ProjectRecord> {
    this.records.set(id, record);
    return record;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
