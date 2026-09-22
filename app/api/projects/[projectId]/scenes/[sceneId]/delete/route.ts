import { NextResponse } from "next/server";
import { deleteScene, previewSceneDelete } from "@/lib/services/scene-order-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string }> };

/**
 * What deleting this scene would cost, without deleting it.
 *
 * Sits beside the move and insert previews rather than on the scene resource
 * itself, so the three operations of this feature read the same way.
 */
export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const preview = await previewSceneDelete(params.projectId, params.sceneId);
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Remove the scene.
 *
 * POST rather than DELETE for symmetry with the other two operations, which
 * both need a request body and a companion preview on the same path.
 */
export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const result = await deleteScene(params.projectId, params.sceneId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
