import { NextResponse } from "next/server";
import { markScenesUndressed } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Set the cast of the named scenes to nude in one go.
 *
 * Scenes that already carry a wardrobe change are left alone: those were set
 * deliberately, and this is a bulk convenience.
 */
export async function POST(request: Request, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const body = (await request.json()) as { sceneIds?: unknown };
    const sceneIds = Array.isArray(body?.sceneIds)
      ? body.sceneIds.filter((id): id is string => typeof id === "string")
      : [];
    const { changed } = await markScenesUndressed(params.projectId, sceneIds);
    return NextResponse.json({ changed }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
