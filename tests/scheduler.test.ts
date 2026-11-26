import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, generateStoryboard, getProjectRecord } from "@/lib/services/project-service";
import { repository } from "@/lib/db/store";
import {
  enqueueSceneRun,
  getQueue,
  missingKeyframeSceneIds,
  resetSceneQueue,
  waitForQueue,
} from "@/lib/services/scene-queue";
import { resetCanvasQueue } from "@/lib/services/canvas-queue";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { setWangpClient } from "@/lib/wangp/factory";
import { createFileScheduleStore, createMemoryScheduleStore, setScheduleStore, scheduleStore } from "@/lib/db/schedule-store";
import { resetSchedulerRuntime, schedulerRuntime } from "@/lib/services/scheduler-state";
import { isGenerationBusy, resetSingleRenders } from "@/lib/services/generation-busy";
import {
  addScheduleItem,
  scheduleAction,
  setSchedulerTiming,
  waitForSchedulerIdle,
} from "@/lib/services/scheduler-service";
import { bindFromUrl, restartWangp } from "@/lib/services/wangp-restart-service";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { GenerationMode, SceneContinuityMode } from "@/lib/types";
import * as queueRoute from "@/app/api/projects/[projectId]/queue/route";
import * as canvasRunRoute from "@/app/api/projects/[projectId]/canvas-run/route";
import * as generateStoryboardRoute from "@/app/api/projects/[projectId]/generate-storyboard/route";
import * as sceneGenerateRoute from "@/app/api/projects/[projectId]/scenes/[sceneId]/generate/route";

/**
 * The Scheduler against the real queues: what a Video item queues for each
 * shape of scene, that a scheduled storyboard never starts a full-auto batch,
 * that manual runs are refused while it owns the GPU, and that its file and
 * its WanGP restart behave.
 */

async function project(mode: GenerationMode = "video_segments", continuity?: SceneContinuityMode) {
  const created = await createProject({
    concept: "A lighthouse keeper's daughter rows out at night.",
    requestedDurationSeconds: 80,
    generationMode: mode,
    ...(continuity ? { sceneContinuity: continuity } : {}),
  });
  return created;
}

/** Give each scene's chosen attempt the media a test needs. */
async function withAttempts(
  record: ProjectRecord,
  shapes: ("none" | "keyframes" | "clip")[],
): Promise<ProjectRecord> {
  const attempts: Record<string, unknown[]> = {};
  record.storyboard!.scenes.forEach((scene, i) => {
    const shape = shapes[i] ?? "none";
    if (shape === "none") return;
    attempts[scene.id] = [
      {
        id: `${scene.id}-a`,
        startImagePath: "start.png",
        ...(shape === "clip" ? { videoPath: "clip.mp4" } : {}),
      },
    ];
  });
  const next = { ...record, attempts } as unknown as ProjectRecord;
  await repository.update(record.project.id, next);
  return next;
}

beforeEach(() => {
  setWangpClient(new MockWangpClient());
  resetSceneQueue();
  resetCanvasQueue();
  resetSchedulerRuntime();
  resetSingleRenders();
  setScheduleStore(createMemoryScheduleStore());
  setSchedulerTiming({ followMs: 5, settleMs: 0 });
});

afterEach(async () => {
  await waitForQueue();
});

describe("enqueueSceneRun", () => {
  it("queues a full pass, a clip only, or nothing, by what each scene holds", async () => {
    const created = await project();
    const record = await withAttempts(await generateStoryboard(created.id), ["none", "keyframes", "clip"]);
    const [s1, s2, s3] = record.storyboard!.scenes;

    const { entries, skippedFinished } = await enqueueSceneRun(created.id);
    const scopes = Object.fromEntries(entries.map((entry) => [entry.sceneId, entry.scope]));
    expect(scopes[s1!.id]).toBe("full");
    expect(scopes[s2!.id]).toBe("video");
    expect(scopes[s3!.id]).toBeUndefined();
    expect(skippedFinished).toBe(1);
  });

  it("rebuilds a finished clip from its keyframes when asked to redo", async () => {
    const created = await project();
    const record = await withAttempts(await generateStoryboard(created.id), ["clip", "clip"]);
    const { entries } = await enqueueSceneRun(created.id, {
      sceneIds: [record.storyboard!.scenes[0]!.id],
      redoFinished: true,
    });
    expect(entries.map((entry) => entry.scope)).toEqual(["video"]);
  });

  it("extends picked scenes forward on continue_video and rebuilds the chain after them", async () => {
    const created = await project("video_segments", "continue_video");
    const base = await generateStoryboard(created.id);
    const record = await withAttempts(base, base.storyboard!.scenes.map((_, i) => (i === 1 ? "keyframes" : "clip")));
    const scenes = record.storyboard!.scenes;

    const { entries, cascaded } = await enqueueSceneRun(created.id, { sceneIds: [scenes[1]!.id] });
    expect(cascaded).toBe(scenes.length > 2);
    // Scene 2 lacked its clip; every clip after it continues from it, so they are rebuilt too.
    expect(entries.map((entry) => entry.sceneNumber)).toEqual(scenes.slice(1).map((s) => s.sceneNumber));
    expect(entries.every((entry) => entry.scope === "video")).toBe(true);
  });

  it("queues what Generate all media would on a fresh project", async () => {
    const created = await project();
    const record = await generateStoryboard(created.id);
    const { entries } = await enqueueSceneRun(created.id);
    expect(entries).toHaveLength(record.storyboard!.scenes.length);
    expect(entries.every((entry) => entry.scope === "full")).toBe(true);
  });
});

describe("missingKeyframeSceneIds", () => {
  it("reads the chosen attempt, not any attempt", async () => {
    const created = await project();
    const record = await generateStoryboard(created.id);
    const [s1, s2] = record.storyboard!.scenes;
    const withHistory = {
      ...record,
      attempts: {
        // An older attempt had frames; the newest (chosen) one does not.
        [s1!.id]: [{ id: "old", startImagePath: "old.png" }, { id: "new" }],
        [s2!.id]: [{ id: "only", startImagePath: "start.png" }],
      },
    } as unknown as ProjectRecord;

    const missing = missingKeyframeSceneIds(withHistory);
    expect(missing).toContain(s1!.id);
    expect(missing).not.toContain(s2!.id);
  });
});

describe("full_auto under the Scheduler", () => {
  it("does not start the media batch for a scheduled storyboard, and says so", async () => {
    const created = await project("full_auto");
    const { item } = await addScheduleItem({ projectId: created.id, runType: "storyboard" }, 0);
    await scheduleAction("start", (await scheduleStore().read()).revision);
    await waitForSchedulerIdle(20_000);

    const finished = (await scheduleStore().read()).items.find((i) => i.id === item.id)!;
    expect(finished.state).toBe("completed");
    expect(finished.summary?.notes?.[0]).toMatch(/Full auto media start was skipped/);
    expect((await getProjectRecord(created.id)).storyboard).toBeTruthy();
    expect(getQueue(created.id).entries).toEqual([]);
  }, 30_000);

  it("still starts it for a storyboard run by hand", async () => {
    const created = await project("full_auto");
    const record = await generateStoryboard(created.id);
    expect(getQueue(created.id).entries).toHaveLength(record.storyboard!.scenes.length);
  });
});

describe("manual runs while a scheduled item runs (FR-18)", () => {
  const ROUTES = path.join(process.cwd(), "app", "api");

  /** Anything that starts planning or WanGP work. */
  const GPU_STARTERS =
    /\b(enqueueCanvasRun|enqueueProjectScenes|enqueueVideoRerun|enqueueKeyframeRerun|generateSceneMedia|generateSceneKeyframe|swapAttemptFrame|pinOpeningFrame|runDeepy|enqueueSceneChecks|checkThenRender|previewSceneCheckFix|refineScenesWithFeedback|previewCardFeedback|previewSceneFeedback|rewriteDialogue|regenerateAllScenePrompts|regenerateScenesPrompts|regenerateScenePrompts|previewSimplifiedPrompts|repairNegativePrompts|readConceptImages|checkConceptFidelity|enhanceConcept|generateStoryPlan|generateWorldBible|generateDirectorialPlan|generateCinematographyPlan|generateArtDirectionPlan|generateAudioPlan|generateStoryboard|generateVariants|generateAnimatic|generateAudioCue|submitJob|loadPlanningModel|unloadPlanningModel|drainDurableSceneBatch|drainDurableCanvasRun|insertScene)\(/;

  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(full);
      return entry.name === "route.ts" ? [full] : [];
    });
  }

  it("guards every route that starts GPU work", () => {
    const unguarded = routeFiles(ROUTES)
      .filter((file) => !file.includes(`${path.sep}scheduler${path.sep}`))
      .filter((file) => GPU_STARTERS.test(fs.readFileSync(file, "utf8")))
      .filter((file) => !fs.readFileSync(file, "utf8").includes("assertManualRunAllowed("))
      .map((file) => path.relative(ROUTES, file));
    expect(unguarded).toEqual([]);
  });

  const HANDLERS = {
    queue: queueRoute,
    "canvas-run": canvasRunRoute,
    "generate-storyboard": generateStoryboardRoute,
    "scenes/[sceneId]/generate": sceneGenerateRoute,
  } as const;

  async function post(route: keyof typeof HANDLERS, params: Record<string, string>, body?: unknown) {
    const mod = HANDLERS[route] as unknown as {
      POST: (request: Request, props: { params: Promise<Record<string, string>> }) => Promise<Response>;
    };
    return mod.POST(
      new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body ?? {}) }),
      { params: Promise.resolve(params) },
    );
  }

  it("refuses with 409 naming the item, and runs normally otherwise", async () => {
    const created = await project();
    const record = await generateStoryboard(created.id);
    const sceneId = record.storyboard!.scenes[0]!.id;
    const now = new Date().toISOString();
    schedulerRuntime().current = {
      itemId: "i1",
      projectId: "other",
      runType: "video",
      label: "Video — Night Harbor",
      position: 2,
      total: 5,
      phase: "running",
      phaseStartedAt: now,
      startedAt: now,
    };

    for (const [route, params] of [
      ["queue", { projectId: created.id }],
      ["canvas-run", { projectId: created.id }],
      ["generate-storyboard", { projectId: created.id }],
      ["scenes/[sceneId]/generate", { projectId: created.id, sceneId }],
    ] as const) {
      const res = await post(route, params);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        "The Scheduler is running Video — Night Harbor (item 2 of 5). Pause the schedule to run something by hand.",
      );
    }

    schedulerRuntime().current = null;
    const res = await post("queue", { projectId: created.id });
    expect(res.status).toBe(200);
  });

  it("counts a single-scene render as GPU work while it runs", async () => {
    const created = await project();
    const record = await generateStoryboard(created.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class GatedClient extends MockWangpClient {
      override async generate(settings: Record<string, unknown>) {
        await gate;
        return super.generate(settings);
      }
    }
    setWangpClient(new GatedClient());

    const pending = post("scenes/[sceneId]/generate", {
      projectId: created.id,
      sceneId: record.storyboard!.scenes[0]!.id,
    });
    for (let i = 0; i < 20 && !isGenerationBusy(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(isGenerationBusy()).toBe(true);
    release();
    await pending;
    expect(isGenerationBusy()).toBe(false);
  });
});

describe("the schedule file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "storyforge-schedule-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes atomically and bumps the revision on every change", async () => {
    const file = path.join(dir, "run-schedule.json");
    const store = createFileScheduleStore(file);
    await store.mutate((draft) => {
      draft.state = "paused";
    });
    const { schedule } = await store.mutate(() => undefined);

    expect(schedule.revision).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ revision: 2, state: "paused" });
    expect(fs.readdirSync(dir)).toEqual(["run-schedule.json"]);
  });

  it("quarantines a file that will not parse and starts empty", async () => {
    const file = path.join(dir, "run-schedule.json");
    fs.writeFileSync(file, "{ not json");
    const schedule = await createFileScheduleStore(file).read();

    expect(schedule).toMatchObject({ state: "idle", items: [], revision: 0 });
    expect(fs.readdirSync(dir).some((name) => /^run-schedule\.corrupt-.+\.json$/.test(name))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("restartWangp", () => {
  let dir: string;
  let launcher: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "storyforge-launcher-"));
    launcher = path.join(dir, "Wan2GP-MCP-Launcher.ps1");
    fs.writeFileSync(launcher, "param([switch]$NoClipboard)");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const healthy = async () => ({ enabled: true, mode: "live" as const, url: "", ok: true, filesystemReads: true });
  const down = async () => ({ enabled: true, mode: "live" as const, url: "", ok: false });
  const base = { isMock: () => false, sleep: async () => undefined, pollMs: 5_000 };

  it("runs the launcher's Restart without a shell, bound to WANGP_MCP_URL", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const result = await restartWangp({
      ...base,
      launcherPath: launcher,
      status: healthy,
      exec: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, output: "Wan2GP MCP is listening." };
      },
    });

    expect(result.outcome).toBe("restarted");
    expect(calls[0]!.file).toBe("powershell.exe");
    const args = calls[0]!.args;
    expect(args.slice(args.indexOf("-Action"), args.indexOf("-Action") + 3)).toEqual(["-Action", "Restart", "-NoPause"]);
    const bind = bindFromUrl("http://127.0.0.1:7866/mcp")!;
    expect(args).toEqual(expect.arrayContaining(["-BindAddress", bind.host, "-Port", bind.port, "-NoClipboard"]));
  });

  it("does not trust a zero exit code when WanGP stays down", async () => {
    const result = await restartWangp({
      ...base,
      launcherPath: launcher,
      status: down,
      exec: async () => ({ code: 0, output: "" }),
    });
    expect(result.outcome).toBe("unhealthy");
  });

  it("leaves a WanGP the launcher did not start running, with a warning", async () => {
    const result = await restartWangp({
      ...base,
      launcherPath: launcher,
      status: healthy,
      exec: async () => ({ code: 1, output: "No launcher-managed Wan2GP MCP process is currently running." }),
    });
    expect(result.outcome).toBe("not_managed");
    expect(result.detail).toMatch(/left running/);
  });

  it("skips in mock mode or without a launcher, and never runs anything", async () => {
    let ran = false;
    const exec = async () => {
      ran = true;
      return { code: 0, output: "" };
    };
    expect((await restartWangp({ ...base, isMock: () => true, launcherPath: launcher, exec })).outcome).toBe("skipped");
    expect((await restartWangp({ ...base, launcherPath: path.join(dir, "missing.ps1"), exec })).outcome).toBe("skipped");
    expect(ran).toBe(false);
  });

  it("parses the bind address StoryForge dials", () => {
    expect(bindFromUrl("http://100.71.40.31:7866/mcp")).toEqual({ host: "100.71.40.31", port: "7866" });
    expect(bindFromUrl("http://localhost:7866/mcp")).toEqual({ host: "127.0.0.1", port: "7866" });
  });
});
