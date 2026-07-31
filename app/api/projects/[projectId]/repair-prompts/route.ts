import { NextResponse } from "next/server";
import { repairNegativePrompts } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Rewrite this project's stored negative prompts as term lists.
 *
 * Mechanical and idempotent: no model runs, no prompt is reworded, and running
 * it twice changes nothing the second time.
 */
export async function POST(_request: Request, { params }: { params: { projectId: string } }) {
  try {
    const { record, changed } = await repairNegativePrompts(params.projectId);
    return NextResponse.json(
      { changed, scenes: record.storyboard?.scenes.length ?? 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
