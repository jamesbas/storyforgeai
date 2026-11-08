import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { sceneCheckRunSchema } from "@/lib/schemas/scene-check";
import { getProjectRecord } from "@/lib/services/project-service";
import {
  cancelSceneChecks,
  checkThenRender,
  enqueueSceneChecks,
  getSceneCheckProgress,
  summariseSceneChecks,
} from "@/lib/services/scene-check-service";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Scene checks: stored results, each scene's status against its current
 * inputs, and the progress of any run.
 *
 * Status is computed here rather than in the browser so a result whose scene
 * has since been edited can never be shown as passed.
 */
export async function GET(_request: Request, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  try {
    const record = await getProjectRecord(projectId);
    return NextResponse.json({
      checks: record.sceneChecks ?? {},
      status: await summariseSceneChecks(record),
      progress: getSceneCheckProgress(projectId),
    }, noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Check the named scenes, quick or deep. Never the whole storyboard unless every
 * scene is named. With `thenRender`, the scenes that pass are queued for that
 * rerun once the checks finish, and the rest are held with their reasons.
 */
export async function POST(request: Request, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  try {
    const { sceneIds, depth, thenRender } = sceneCheckRunSchema.parse(await request.json());
    const queued = thenRender
      ? await checkThenRender(projectId, sceneIds, depth, thenRender)
      : await enqueueSceneChecks(projectId, sceneIds, depth);
    return NextResponse.json({ queued: queued.length, progress: getSceneCheckProgress(projectId) }, {
      status: 202, ...noStore,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Cancel checks not yet started. */
export async function DELETE(_request: Request, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  try {
    const cancelled = cancelSceneChecks(projectId);
    return NextResponse.json({ cancelled, progress: getSceneCheckProgress(projectId) }, noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}
