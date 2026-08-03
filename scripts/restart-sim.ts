import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Production restart simulation (SPEC-008 §15).
 *
 * Writes the exact task file a killed process would have left, then boots the
 * real startup hook against it and reports what recovery decided. Proves FR-3,
 * FR-5 and FR-11 outside the test runner, against the built app's own code.
 *
 * Run: npm run tasks:restart-sim
 */

const dataDir = path.join(os.tmpdir(), `sf-restart-sim-${randomUUID()}`);

type Case = {
  name: string;
  state: string;
  externalJobId?: string;
  expect: string;
};

const CASES: Case[] = [
  {
    name: "killed between intent and backend acceptance",
    state: "submitting",
    expect: "submission_unknown",
  },
  {
    name: "killed after acceptance, job id persisted",
    state: "running",
    externalJobId: "wangp-live-1",
    expect: "reconciling",
  },
  { name: "killed while running with no job id", state: "running", expect: "interrupted" },
  { name: "finished before the crash", state: "completed", expect: "completed" },
  { name: "never started", state: "pending", expect: "pending" },
];

function entryFor(index: number, testCase: Case) {
  const now = new Date().toISOString();
  return {
    id: `entry-${index}`,
    ref: `sim-scene-00${index}`,
    label: `Scene ${index}`,
    order: index,
    state: testCase.state,
    attempts: 1,
    history: [],
    ...(testCase.externalJobId ? { externalJobId: testCase.externalJobId } : {}),
    ...(testCase.state === "completed" ? { finishedAt: now } : {}),
    startedAt: now,
  };
}

async function main() {
  const projectId = "sim-project";
  await fs.mkdir(path.join(dataDir, projectId), { recursive: true });

  const now = new Date().toISOString();
  const taskFile = {
    schemaVersion: 1,
    revision: 7,
    // A lease held by the process that just died.
    lease: { owner: "dead-worker", heldUntil: new Date(Date.now() + 60_000).toISOString() },
    tasks: [
      {
        id: "task-sim",
        projectId,
        kind: "scene_batch",
        state: "running",
        createdAt: now,
        updatedAt: now,
        entries: CASES.map((c, i) => entryFor(i + 1, c)),
      },
    ],
  };
  await fs.writeFile(
    path.join(dataDir, projectId, "tasks.json"),
    JSON.stringify(taskFile, null, 2),
    "utf8",
  );

  process.env.STORYFORGE_DATA_DIR = dataDir;
  process.env.STORYFORGE_PERSISTENCE = "file";
  process.env.DURABLE_TASKS = "true";

  const { reconcileStartup } = await import("@/lib/tasks/startup");
  const { listTasks, acquireLease } = await import("@/lib/tasks/task-service");

  const summary = await reconcileStartup();
  const [task] = await listTasks(projectId);

  let failures = 0;
  console.log(`\nRestart reconciliation: ${JSON.stringify(summary)}\n`);
  CASES.forEach((testCase, index) => {
    const actual = task.entries[index].state;
    const ok = actual === testCase.expect;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${testCase.name}\n      ${testCase.state} -> ${actual} (expected ${testCase.expect})`);
  });

  // A dead process must not keep the project locked forever.
  const reclaimed = await acquireLease(projectId);
  if (!reclaimed) failures += 1;
  console.log(`${reclaimed ? "PASS" : "FAIL"}  stale lease reclaimed after restart`);

  // Nothing may have been silently queued for resubmission.
  const resubmittable = task.entries.filter((e) => e.state === "pending").length;
  const expectedPending = CASES.filter((c) => c.expect === "pending").length;
  const noAutoResubmit = resubmittable === expectedPending;
  if (!noAutoResubmit) failures += 1;
  console.log(
    `${noAutoResubmit ? "PASS" : "FAIL"}  no in-flight work was reset to pending (${resubmittable} pending, expected ${expectedPending})`,
  );

  await fs.rm(dataDir, { recursive: true, force: true });

  if (failures) {
    console.error(`\n${failures} restart check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll restart checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
