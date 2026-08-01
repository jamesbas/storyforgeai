import { NextResponse } from "next/server";
import { updateSceneCard } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Correct a scene card by hand.
 *
 * Every prompt for the scene is written from this text, so a card that
 * describes the wrong shot cannot be fixed by rewriting its prompts.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { projectId: string; sceneId: string } },
) {
  try {
    const body = await request.json();
    const record = await updateSceneCard(params.projectId, params.sceneId, body);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
