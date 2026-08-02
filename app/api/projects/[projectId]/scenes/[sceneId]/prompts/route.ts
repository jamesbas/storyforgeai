import { NextResponse } from "next/server";
import { regenerateScenePrompts, updateScenePrompts } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Rewrite this scene's prompts from its card, leaving the card and every other
 * scene untouched.
 */
export async function POST(
  _request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const record = await regenerateScenePrompts(params.projectId, params.sceneId);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Hand-edit a scene's prompts.
 *
 * These strings are what reaches WanGP, so correcting one shot should not
 * require regenerating the storyboard and losing every other scene's wording.
 */
export async function PATCH(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const body = await request.json();
    const record = await updateScenePrompts(params.projectId, params.sceneId, body);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
