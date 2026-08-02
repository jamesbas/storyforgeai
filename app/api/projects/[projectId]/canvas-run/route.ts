import { NextResponse } from "next/server";
import {
  cancelCanvasRun,
  enqueueCanvasRun,
  getCanvasQueue,
} from "@/lib/services/canvas-queue";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

/** Where the crew has got to. Polled by the canvas while a run is in flight. */
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(getCanvasQueue(params.projectId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Queue the crew and return immediately.
 *
 * The run outlives this request on purpose \u2014 it is minutes of work, and the
 * whole point of moving it here was that closing the page must not abandon it.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const body = (await request.json().catch(() => ({}))) as { includeStoryboard?: boolean };
    enqueueCanvasRun(params.projectId, { includeStoryboard: body.includeStoryboard ?? true });
    return NextResponse.json(getCanvasQueue(params.projectId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Abandon whatever has not started yet. The agent in flight still finishes. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    cancelCanvasRun(params.projectId);
    return NextResponse.json(getCanvasQueue(params.projectId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
