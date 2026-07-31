import { NextResponse } from "next/server";
import { updateSceneWardrobe } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Set or clear the costume changes at one scene.
 *
 * A change applies from this scene onward, so this rewrites what every later
 * scene wears. It reaches a render when those scenes' prompts are next written.
 */
export async function PUT(
  request: Request,
  { params }: { params: { projectId: string; sceneId: string } },
) {
  try {
    const body = await request.json();
    const { record, warning } = await updateSceneWardrobe(
      params.projectId,
      params.sceneId,
      body?.changes ?? [],
    );
    return NextResponse.json({ record, warning }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
