import { describe, it, expect, beforeEach } from "vitest";
import { createProject, generateStoryboard, listProjects } from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { getAgentRun, resetAgentRuns, trackAgentRun } from "@/lib/services/agent-runs";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Two pieces of state the app used to lose.
 *
 * `project.status` was written when media generation started and never set
 * back, so every finished project read as "generating" on the Projects screen
 * for the rest of its life. And a canvas agent's run state lived only in the
 * component that started it, so navigating away and back showed an idle screen
 * with unlocked buttons while the agent was still working.
 */

async function statusOf(id: string): Promise<string | undefined> {
  return (await listProjects()).find((p) => p.id === id)?.status;
}

describe("the status the Projects screen shows", () => {
  beforeEach(() => {
    setWangpClient(new MockWangpClient());
  });

  it("is draft before a storyboard exists", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    expect(await statusOf(project.id)).toBe("draft");
  });

  it("is storyboard_ready once scenes exist but no media does", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    await generateStoryboard(project.id);
    expect(await statusOf(project.id)).toBe("storyboard_ready");
  });

  /** The reported bug: a finished project stuck reading "generating". */
  it("does not read as generating once the media is done", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    const record: ProjectRecord = await generateStoryboard(project.id);
    const scene = record.storyboard!.scenes[0]!;
    await generateSceneMedia(project.id, scene.id);

    expect(await statusOf(project.id)).not.toBe("generating");
    expect(await statusOf(project.id)).toBe("needs_review");
  });

  it("is approved when every scene has an approved attempt", async () => {
    const project = await createProject({
      concept: "A courier crosses a flooded city.",
      requestedDurationSeconds: 60,
    });
    let record: ProjectRecord = await generateStoryboard(project.id);
    for (const scene of record.storyboard!.scenes) {
      record = await generateSceneMedia(project.id, scene.id);
      const attempt = record.attempts![scene.id]!.at(-1)!;
      record = await approveAttempt(project.id, scene.id, attempt.id);
    }
    expect(await statusOf(project.id)).toBe("approved");
  });
});

describe("tracking which agent is running", () => {
  beforeEach(() => {
    resetAgentRuns();
  });

  it("reports nothing when idle", () => {
    expect(getAgentRun("p1")).toBeNull();
  });

  it("reports the run while it is in flight", async () => {
    let seen: string | null = null;
    await trackAgentRun("p1", "director", "Director", async () => {
      seen = getAgentRun("p1")?.agentKey ?? null;
    });
    expect(seen).toBe("director");
  });

  it("clears the run once it finishes", async () => {
    await trackAgentRun("p1", "director", "Director", async () => undefined);
    expect(getAgentRun("p1")).toBeNull();
  });

  /** A failed agent must not leave the project looking permanently busy. */
  it("clears the run when the agent throws", async () => {
    await expect(
      trackAgentRun("p1", "world", "World Builder", async () => {
        throw new Error("model unreachable");
      }),
    ).rejects.toThrow("model unreachable");
    expect(getAgentRun("p1")).toBeNull();
  });

  it("keeps runs for different projects apart", async () => {
    await trackAgentRun("p1", "art", "Art Director", async () => {
      expect(getAgentRun("p2")).toBeNull();
      expect(getAgentRun("p1")?.agentKey).toBe("art");
    });
  });
});
