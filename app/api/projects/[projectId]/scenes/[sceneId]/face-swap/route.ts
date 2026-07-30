import { NextResponse } from "next/server";
import { swapAttemptFrame } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Apply the face swap to one already-rendered keyframe.
 *
 * The repair path for when the planned shot and the actual render disagree —
 * the automatic pass is decided before anything is drawn.
 */
export async function POST(
  request: Request,
  { params }: { params: { projectId: string; sceneId: string } },
) {
  try {
    const { purpose } = (await request.json()) as { purpose?: unknown };
    if (purpose !== "start_frame" && purpose !== "end_frame") {
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
