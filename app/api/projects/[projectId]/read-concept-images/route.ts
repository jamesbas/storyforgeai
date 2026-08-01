import { NextResponse } from "next/server";
import { readConceptImages } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Run the Concept Reader against the project's uploaded images.
 *
 * On demand rather than automatic: reading images is the slowest planning call
 * in the app, and they change far less often than the story does.
 */
export async function POST(_request: Request, { params }: { params: { projectId: string } }) {
  try {
    const record = await readConceptImages(params.projectId);
    return NextResponse.json(
      { conceptVisuals: record.conceptVisuals },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
