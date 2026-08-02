import { NextResponse } from "next/server";
import { revertAttemptFrame, swapAttemptFrame } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

function framePurpose(value: unknown): "start_frame" | "end_frame" | null {
  return value === "start_frame" || value === "end_frame" ? value : null;
}

/**
 * Apply the face swap to one already-rendered keyframe.
 *
 * The repair path for when the planned shot and the actual render disagree —
 * the automatic pass is decided before anything is drawn.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const body = (await request.json()) as { purpose?: unknown };
    const purpose = framePurpose(body.purpose);
    if (!purpose) {
      return NextResponse.json(
        { error: "purpose must be start_frame or end_frame" },
        { status: 400 },
      );
    }
    const record = await swapAttemptFrame(params.projectId, params.sceneId, purpose);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Undo a swap, restoring the frame as it was rendered. */
export async function DELETE(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const purpose = framePurpose(new URL(request.url).searchParams.get("purpose"));
    if (!purpose) {
      return NextResponse.json(
        { error: "purpose must be start_frame or end_frame" },
        { status: 400 },
      );
    }
    const record = await revertAttemptFrame(params.projectId, params.sceneId, purpose);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
