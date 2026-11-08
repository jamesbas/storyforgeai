import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { sceneFindingAcceptSchema } from "@/lib/schemas/scene-check";
import { acceptSceneFinding } from "@/lib/services/scene-check-service";

export const dynamic = "force-dynamic";

/**
 * Mark one finding as intentional, or take that back.
 *
 * The acceptance is tied to the inputs the finding was raised against, so it
 * lapses the moment the scene's card or prompts change.
 */
export async function PATCH(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> },
) {
  const { projectId, sceneId } = await props.params;
  try {
    const { depth, findingId, accepted } = sceneFindingAcceptSchema.parse(await request.json());
    const record = await acceptSceneFinding(projectId, sceneId, depth, findingId, accepted);
    return NextResponse.json(
      { check: record.sceneChecks?.[sceneId]?.[depth] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
