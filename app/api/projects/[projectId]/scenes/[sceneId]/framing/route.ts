import { NextResponse } from "next/server";
import { updateSceneFraming } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Correct what the planner said about a shot's framing.
 *
 * Whether the face is in frame decides if the face-swap pass runs, and the plan
 * and the render can disagree — so it has to be fixable without regenerating
 * the storyboard.
 */
export async function PATCH(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const body = await request.json();
    const record = await updateSceneFraming(params.projectId, params.sceneId, body);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
