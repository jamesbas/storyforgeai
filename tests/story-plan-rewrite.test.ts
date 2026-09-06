import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Asking for a new narrative arc.
 *
 * The arc is written once and then defended: `storyPlanNeedsWriting` declines
 * to replace one a model produced, which is right for the automatic callers —
 * without it every canvas run would churn a good arc — but it left the arc as
 * the one artifact that could never be redone. A prompt improvement could not
 * reach any project that already had one, and the only remedy was editing
 * `project.json` by hand.
 *
 * So the guard stays where it was and this path ignores it: automatic when the
 * project has no arc, deliberate when it has one worth replacing.
 */

const dirs: string[] = [];

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-story-plan-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();

  const projects = await import("@/lib/services/project-service");
  const { repository } = await import("@/lib/db/store");
  return { projects, repository };
}

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function project(env: Awaited<ReturnType<typeof isolated>>) {
  const created = await env.projects.createProject({
    concept: "A lock-keeper walks the towpath at dawn and finds the gates jammed.",
    requestedDurationSeconds: 60,
  });
  return created.id;
}

describe("rewriting the narrative arc", () => {
  it("writes one when the project has none", async () => {
    const env = await isolated();
    const id = await project(env);
    expect((await env.projects.getProjectRecord(id)).storyPlan).toBeUndefined();

    const record = await env.projects.generateStoryPlan(id);

    expect(record.storyPlan).toBeDefined();
    expect(record.storyPlan!.segmentBeats).toHaveLength(record.project.segmentCount);
  });

  it("replaces one that is already there, which the automatic path refuses to do", async () => {
    const env = await isolated();
    const id = await project(env);

    const first = await env.projects.generateStoryPlan(id);
    // Stand in for a model-written arc: the guard keys on provenance, and a
    // record claiming `llm` is exactly what it declines to touch.
    await env.repository.update(id, {
      ...first,
      storyPlan: { ...first.storyPlan!, logline: "The arc a model wrote." },
      executions: [
        ...(first.executions ?? []),
        {
          executionId: "x1",
          artifact: "story_plan",
          scope: "project",
          source: "llm",
          status: "ok",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1000,
        },
      ],
    });

    const rewritten = await env.projects.generateStoryPlan(id);
    expect(rewritten.storyPlan!.logline).not.toBe("The arc a model wrote.");
  });

  it("records the rewrite in the project's history", async () => {
    const env = await isolated();
    const id = await project(env);

    const record = await env.projects.generateStoryPlan(id);
    expect(record.history?.some((entry) => entry.action === "story_plan.generated")).toBe(true);
  });

  it("leaves the storyboard alone, so nothing is silently rewritten under it", async () => {
    const env = await isolated();
    const id = await project(env);
    await env.projects.generateStoryboard(id);
    const before = await env.projects.getProjectRecord(id);

    const after = await env.projects.generateStoryPlan(id);

    expect(after.storyboard).toEqual(before.storyboard);
  });
});
