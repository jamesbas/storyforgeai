import { NextResponse } from "next/server";
import { cancelQueue, clearFinished, enqueueProjectScenes, getQueue } from "@/lib/services/scene-queue";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

/** Progress of the scene generation queue. Polled by the storyboard screen. */
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(getQueue(params.projectId), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Queue every scene still lacking media, or all of them when `all` is set.
 *
 * Returns as soon as the work is queued: a full project is many minutes of GPU
 * time, far longer than a request should be held open.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const url = new URL(request.url);
    const includeGenerated = url.searchParams.get("all") === "1";
    clearFinished(params.projectId);
    const queued = await enqueueProjectScenes(params.projectId, { includeGenerated });
    return NextResponse.json({ queued: queued.length, ...getQueue(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Abandon the scenes that have not started yet. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const cancelled = cancelQueue(params.projectId);
    return NextResponse.json({ cancelled, ...getQueue(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
