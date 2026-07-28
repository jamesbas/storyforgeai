import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Data-access interface. The pipeline talks only to this interface so the
 * in-memory demo store can be swapped for a Prisma-backed store without
 * rewriting application logic (generic-build-spec Section 2.3 / 4).
 */
export interface ProjectRepository {
  create(record: ProjectRecord): Promise<ProjectRecord>;
  get(id: string): Promise<ProjectRecord | null>;
  list(): Promise<ProjectRecord[]>;
  update(id: string, record: ProjectRecord): Promise<ProjectRecord>;
  /** Remove the record, leaving any generated media in place. */
  delete(id: string): Promise<boolean>;
  /**
   * Remove the record *and* everything stored alongside it.
   *
   * Separate from `delete` because generated media is expensive to reproduce,
   * so discarding it has to be an explicit choice rather than a side effect.
   */
  purge(id: string): Promise<boolean>;
}
