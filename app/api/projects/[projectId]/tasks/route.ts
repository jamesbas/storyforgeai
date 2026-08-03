import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";
import { getProjectRecord } from "@/lib/services/project-service";
import {
  dismissCompleted,
  getTaskFile,
  requestCancel,
  retryEntries,
  stopTracking,
} from "@/lib/tasks/task-service";
import { activeSceneTask, drainDurableSceneBatch } from "@/lib/services/scene-task-queue";
import { activeCanvasTask, drainDurableCanvasRun } from "@/lib/services/canvas-task-queue";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Durable task state and recovery actions (SPEC-008).
 *
 * No auth guard here on purpose: the SPEC-007A-lite middleware already covers
 * every path under `/api/`, rejecting a non-allowlisted Host and any cross-site
 * mutating request before a handler runs. Adding a second check would be a
 * second thing to keep correct.
 */
export async function GET(_request: Request, props: Params) {
  const { projectId } = await props.params;
  try {
    // Ownership: a task file is only meaningful for a project that exists, and
    // this throws NotFoundError otherwise.
    await getProjectRecord(projectId);
    const file = await getTaskFile(projectId);
    return NextResponse.json(file, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

type Action = "resume" | "retry" | "cancel" | "stop_tracking" | "dismiss";

export async function POST(request: Request, props: Params) {
  const { projectId } = await props.params;
  try {
    await getProjectRecord(projectId);
    const body = (await request.json().catch(() => ({}))) as {
      action?: Action;
      taskId?: string;
      entryIds?: string[];
    };

    switch (body.action) {
      case "resume": {
        // Reconciliation already decided what each entry becomes; this restarts
        // the drainer so `reconciling` entries get polled.
        const scene = await activeSceneTask(projectId);
        if (scene) void drainDurableSceneBatch(projectId, scene.id);
        const canvas = await activeCanvasTask(projectId);
        if (canvas) void drainDurableCanvasRun(projectId, canvas.id);
        break;
      }
      case "retry": {
        if (!body.taskId) throw new ValidationError("A task id is required to retry.");
        await retryEntries(projectId, body.taskId, body.entryIds);
        const scene = await activeSceneTask(projectId);
        if (scene?.id === body.taskId) void drainDurableSceneBatch(projectId, scene.id);
        const canvas = await activeCanvasTask(projectId);
        if (canvas?.id === body.taskId) void drainDurableCanvasRun(projectId, canvas.id);
        break;
      }
      case "cancel":
        await requestCancel(projectId, body.taskId);
        break;
      case "stop_tracking":
        if (!body.taskId) throw new ValidationError("A task id is required to stop tracking.");
        await stopTracking(projectId, body.taskId);
        break;
      case "dismiss":
        await dismissCompleted(projectId);
        break;
      default:
        throw new ValidationError("Unknown task action.");
    }

    const file = await getTaskFile(projectId);
    return NextResponse.json(file, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
