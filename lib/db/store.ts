import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ProjectRepository } from "@/lib/db/repository";
import { InMemoryProjectRepository } from "@/lib/db/in-memory-repository";
import { FileProjectRepository } from "@/lib/db/file-repository";
import { config } from "@/lib/config";

/**
 * Process-wide singleton so the store survives Next.js HMR in dev and is shared
 * across route handlers. The repository is chosen by config: `file` (the
 * default) keeps projects across restarts, `memory` is for tests and throwaway
 * runs, and the Prisma store lands in a later hardening pass.
 */
const globalRef = globalThis as unknown as {
  __storyforgeRepo?: ProjectRepository;
  __storyforgeStore?: Map<string, ProjectRecord>;
};

const store = globalRef.__storyforgeStore ?? (globalRef.__storyforgeStore = new Map());

function createRepository(): ProjectRepository {
  if (config.persistence === "memory") return new InMemoryProjectRepository(store);
  return new FileProjectRepository();
}

export const repository: ProjectRepository =
  globalRef.__storyforgeRepo ?? (globalRef.__storyforgeRepo = createRepository());
