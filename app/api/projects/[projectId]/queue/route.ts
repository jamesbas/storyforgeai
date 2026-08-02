import { NextResponse } from "next/server";
import {
  cancelQueue,
  clearFinished,
  enqueueProjectScenes,
  enqueueVideoRerun,
  getQueue,
} from "@/lib/services/scene-queue";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/** Progress of the scene generation queue. Polled by the storyboard screen. */
export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    return NextResponse.json(getQueue(params.projectId), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Queue scene generation.
 *
 * `all=1` redoes scenes that already have media. `video=1` rebuilds only the
 * clips, reusing the keyframes on the record, optionally for a named subset.
 *
 * Returns as soon as the work is queued: a full project is many minutes of GPU
 * time, far longer than a request should be held open.
 */
export async function POST(request: Request, props: Params) {
  const params = await props.params;
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("video") === "1") {
      const body = (await request.json().catch(() => ({}))) as { sceneIds?: string[] };
      clearFinished(params.projectId);
      const { entries, cascaded } = await enqueueVideoRerun(params.projectId, body.sceneIds);
      return NextResponse.json({
        queued: entries.length,
        cascaded,
        ...getQueue(params.projectId),
      });
    }

    const includeGenerated = url.searchParams.get("all") === "1";
    clearFinished(params.projectId);
    const queued = await enqueueProjectScenes(params.projectId, { includeGenerated });
    return NextResponse.json({ queued: queued.length, ...getQueue(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Abandon the scenes that have not started yet. */
export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const cancelled = cancelQueue(params.projectId);
    return NextResponse.json({ cancelled, ...getQueue(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
