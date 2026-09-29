import { NextResponse } from "next/server";
import { clearSceneSeeds } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Re-roll the image seed of several scenes in one go.
 *
 * The per-scene route does the same for one card. Body: `{ sceneIds: string[] }`.
 * Returns the updated record and which scenes actually had a seed to drop.
 */
export async function DELETE(request: Request, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const body = (await request.json().catch(() => ({}))) as { sceneIds?: unknown };
    const sceneIds = Array.isArray(body?.sceneIds)
      ? body.sceneIds.filter((id): id is string => typeof id === "string")
      : [];
    const { record, cleared } = await clearSceneSeeds(params.projectId, sceneIds);
    return NextResponse.json({ record, cleared }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
