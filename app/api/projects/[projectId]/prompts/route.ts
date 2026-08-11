import { NextResponse } from "next/server";
import { regenerateAllScenePrompts, regenerateScenesPrompts } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The picked scenes, or none when the caller sent no body at all. */
async function pickedScenes(request: Request): Promise<string[]> {
  try {
    const body = (await request.json()) as { sceneIds?: unknown };
    return Array.isArray(body?.sceneIds) ? body.sceneIds.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Rewrite scene prompts from their cards, against the models pinned now.
 *
 * Scene cards are left alone: this re-runs the two prompt agents, not the
 * storyboard, so the story survives and only its phrasing changes. An empty
 * selection means every scene, matching the clip queue.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    const sceneIds = await pickedScenes(request);
    const record = sceneIds.length
      ? await regenerateScenesPrompts(projectId, sceneIds)
      : await regenerateAllScenePrompts(projectId);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
