import { NextResponse } from "next/server";
import { clearSceneSeed } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Re-roll a scene's image seed.
 *
 * Seeds are pinned so a preview predicts the keyframe, which also means
 * regenerating a scene reproduces it. This is how a different sample is asked
 * for: the seed is dropped and the next render mints a new one.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { projectId: string; sceneId: string } },
) {
  try {
    const record = await clearSceneSeed(params.projectId, params.sceneId);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
