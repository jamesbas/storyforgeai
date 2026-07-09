/**
 * Idempotent demo seed. In demo/local mode the app uses a per-process in-memory
 * store, so this script is a safe no-op that documents the seeding contract and
 * validates that the service layer boots. When STORYFORGE_PERSISTENCE=prisma it
 * can be extended to upsert demo rows.
 */
import { createProject, listProjects } from "@/lib/services/project-service";

const DEMO_CONCEPT = "A lighthouse keeper befriends a passing storm.";

async function main() {
  const existing = await listProjects();
  if (existing.some((p) => p.concept === DEMO_CONCEPT)) {
    console.log(JSON.stringify({ event: "seed.skip", reason: "already seeded" }));
    return;
  }
  const project = await createProject({
    concept: DEMO_CONCEPT,
    requestedDurationSeconds: 60,
    style: "cinematic",
    tone: "wistful",
  });
  console.log(JSON.stringify({ event: "seed.created", id: project.id }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
