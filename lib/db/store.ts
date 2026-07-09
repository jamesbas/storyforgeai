import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ProjectRepository } from "@/lib/db/repository";
import { InMemoryProjectRepository } from "@/lib/db/in-memory-repository";

/**
 * Process-wide singleton so the in-memory store survives Next.js HMR in dev and
 * is shared across route handlers. The chosen repository is selected by config;
 * today only the in-memory implementation is wired (Prisma store lands in a
 * later hardening pass).
 */
const globalRef = globalThis as unknown as {
  __storyforgeRepo?: ProjectRepository;
  __storyforgeStore?: Map<string, ProjectRecord>;
};

const store = globalRef.__storyforgeStore ?? (globalRef.__storyforgeStore = new Map());

export const repository: ProjectRepository =
  globalRef.__storyforgeRepo ?? (globalRef.__storyforgeRepo = new InMemoryProjectRepository(store));
