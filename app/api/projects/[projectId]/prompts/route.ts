import { NextResponse } from "next/server";
import { regenerateAllScenePrompts } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Rewrite every scene's prompts from its card, against the models pinned now.
 *
 * Scene cards are left alone: this re-runs the two prompt agents, not the
 * storyboard, so the story survives and only its phrasing changes.
 */
export async function POST(
  _request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    const record = await regenerateAllScenePrompts(projectId);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
