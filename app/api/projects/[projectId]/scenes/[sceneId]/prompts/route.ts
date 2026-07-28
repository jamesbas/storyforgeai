import { NextResponse } from "next/server";
import { updateScenePrompts } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Hand-edit a scene's prompts.
 *
 * These strings are what reaches WanGP, so correcting one shot should not
 * require regenerating the storyboard and losing every other scene's wording.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { projectId: string; sceneId: string } },
) {
  try {
    const body = await request.json();
    const record = await updateScenePrompts(params.projectId, params.sceneId, body);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
